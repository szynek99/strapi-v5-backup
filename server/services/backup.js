'use strict';

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const AWS = require('aws-sdk');

module.exports = ({ strapi, database, aws, retentionDays }) => ({
    async runBackup() {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileName = `backup-${timestamp}.dump`;
        const tempPath = path.join(__dirname, fileName);

        const { host, port, name, user, password } = database || {};
        const { bucket, region, accessKeyId, secretAccessKey, prefix = 'backups/' } = aws || {};

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

            proc.stdout?.on('data', (data) => strapi.log.debug(`[pg_dump] ${data.trim()}`));
            proc.stderr?.on('data', (data) => strapi.log.debug(`[pg_dump:stderr] ${data.trim()}`));
        });

        const s3 = new AWS.S3({ accessKeyId, secretAccessKey, region });

        try {
            const fileContent = fs.readFileSync(tempPath);
            strapi.log.info(`[db-backup] 📤 Uploading ${fileName} to S3...`);

            await s3.upload({
                Bucket: bucket,
                Key: `${prefix}${fileName}`,
                Body: fileContent,
            }).promise();

            strapi.log.info(`[db-backup] ✅ Backup uploaded: s3://${bucket}/${prefix}${fileName}`);
        } catch (err) {
            strapi.log.error(`[db-backup] ❌ Upload failed: ${err.message}`);
            throw err;
        } finally {
            try {
                if (fs.existsSync(tempPath)) {
                    fs.unlinkSync(tempPath);
                    strapi.log.debug(`[db-backup] 🧹 Temporary file removed: ${tempPath}`);
                }
            } catch (cleanupErr) {
                strapi.log.warn(`[db-backup] ⚠️ Failed to delete temporary file: ${cleanupErr.message}`);
            }
        }

        return `s3://${bucket}/${prefix}${fileName}`;
    },

    async cleanupOldBackups() {
        const { bucket, region, accessKeyId, secretAccessKey, prefix = 'backups/' } = aws;
        const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
        const now = Date.now();

        strapi.log.info(`[db-backup] 🧹 Cleaning up backups older than ${retentionDays} days...`);

        const s3 = new AWS.S3({ accessKeyId, secretAccessKey, region });

        try {
            const list = await s3.listObjectsV2({ Bucket: bucket, Prefix: prefix }).promise();

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
                    await s3.deleteObject({ Bucket: bucket, Key: file.Key }).promise();
                    strapi.log.info(`[db-backup] 🗑️ Deleted old backup: ${file.Key}`);
                } catch (err) {
                    strapi.log.error(`[db-backup] ⚠️ Failed to delete ${file.Key}: ${err.message}`);
                }
            }
        } catch (err) {
            strapi.log.error(`[db-backup] ❌ Cleanup failed: ${err.message}`);
            if (err.stack) strapi.log.debug(err.stack);
        }
    },
});
