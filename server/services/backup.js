'use strict';

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const {
    S3Client,
    PutObjectCommand,
    DeleteObjectCommand,
    ListObjectsV2Command,
} = require('@aws-sdk/client-s3');

module.exports = ({ strapi, database, aws, retentionDays }) => ({
    async runBackup() {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileName = `backup-${timestamp}.dump`;
        const gzFileName = `${fileName}.gz`;
        const tempPath = path.join(__dirname, fileName);
        const gzTempPath = path.join(__dirname, gzFileName);

        const { host, port, name, user, password } = database || {};
        const {
            bucket,
            region,
            accessKeyId,
            secretAccessKey,
            prefix = 'backups/',
        } = aws || {};

        if (!host || !port || !name || !user || !password) {
            throw new Error('Invalid or incomplete database configuration.');
        }
        if (!bucket || !region || !accessKeyId || !secretAccessKey) {
            throw new Error('Invalid AWS S3 configuration.');
        }

        const dumpCommand = `PGPASSWORD=${password} pg_dump -h ${host} -p ${port} -U ${user} -F c -b -v -f "${tempPath}" ${name}`;

        strapi.log.info(`[db-backup] 🧩 Starting pg_dump for database "${name}"...`);

        await new Promise((resolve, reject) => {
            const proc = exec(dumpCommand, (error, stdout, stderr) => {
                if (error) {
                    strapi.log.error('[db-backup] ❌ pg_dump failed.');
                    strapi.log.debug(stderr);
                    reject(new Error(stderr || error.message));
                } else {
                    strapi.log.info('[db-backup] ✅ pg_dump completed successfully.');
                    resolve();
                }
            });

            proc.stdout?.on('data', (data) =>
                strapi.log.debug(`[pg_dump] ${data.trim()}`)
            );
            proc.stderr?.on('data', (data) =>
                strapi.log.debug(`[pg_dump:stderr] ${data.trim()}`)
            );
        });

        strapi.log.info(`[db-backup] 🗜️ Compressing backup file...`);
        await new Promise((resolve, reject) => {
            const gzip = zlib.createGzip();
            const input = fs.createReadStream(tempPath);
            const output = fs.createWriteStream(gzTempPath);

            input
                .pipe(gzip)
                .pipe(output)
                .on('finish', () => {
                    strapi.log.info('[db-backup] ✅ Compression completed.');
                    resolve();
                })
                .on('error', (err) => {
                    strapi.log.error(`[db-backup] ❌ Compression failed: ${err.message}`);
                    reject(err);
                });
        });

        const s3 = new S3Client({
            region,
            credentials: { accessKeyId, secretAccessKey },
        });

        try {
            const fileStream = fs.createReadStream(gzTempPath);
            const s3Key = `${prefix}${gzFileName}`;
            strapi.log.info(`[db-backup] 📤 Uploading ${gzFileName} to S3...`);

            await s3.send(
                new PutObjectCommand({
                    Bucket: bucket,
                    Key: s3Key,
                    Body: fileStream,
                    ContentType: 'application/gzip',
                    ContentEncoding: 'gzip',
                })
            );

            strapi.log.info(`[db-backup] ✅ Backup uploaded: s3://${bucket}/${s3Key}`);
        } catch (err) {
            strapi.log.error(`[db-backup] ❌ Upload failed: ${err.message}`);
            throw err;
        } finally {
            for (const file of [tempPath, gzTempPath]) {
                try {
                    if (fs.existsSync(file)) {
                        fs.unlinkSync(file);
                        strapi.log.debug(`[db-backup] 🧹 Removed temporary file: ${file}`);
                    }
                } catch (cleanupErr) {
                    strapi.log.warn(
                        `[db-backup] ⚠️ Failed to delete temp file ${file}: ${cleanupErr.message}`
                    );
                }
            }
        }

        return `s3://${bucket}/${prefix}${gzFileName}`;
    },

    async cleanupOldBackups() {
        const {
            bucket,
            region,
            accessKeyId,
            secretAccessKey,
            prefix = 'backups/',
        } = aws;
        const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
        const now = Date.now();

        strapi.log.info(
            `[db-backup] 🧹 Cleaning up backups older than ${retentionDays} days...`
        );

        const s3 = new S3Client({
            region,
            credentials: { accessKeyId, secretAccessKey },
        });

        try {
            const list = await s3.send(
                new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix })
            );

            const oldBackups = (list.Contents || []).filter((obj) => {
                const age = now - new Date(obj.LastModified).getTime();
                return age > retentionMs;
            });

            if (!oldBackups.length) {
                strapi.log.info('[db-backup] 🟢 No old backups to remove.');
                return;
            }

            for (const file of oldBackups) {
                try {
                    await s3.send(
                        new DeleteObjectCommand({ Bucket: bucket, Key: file.Key })
                    );
                    strapi.log.info(`[db-backup] 🗑️ Deleted old backup: ${file.Key}`);
                } catch (err) {
                    strapi.log.error(
                        `[db-backup] ⚠️ Failed to delete ${file.Key}: ${err.message}`
                    );
                }
            }
        } catch (err) {
            strapi.log.error(`[db-backup] ❌ Cleanup failed: ${err.message}`);
            if (err.stack) strapi.log.debug(err.stack);
        }
    },
});
