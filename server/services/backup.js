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

        const { host, port, name, user, password } = database;
        const { bucket, region, accessKeyId, secretAccessKey, prefix = 'backups/' } = aws;

        const dumpCommand = `PGPASSWORD=${password} pg_dump -h ${host} -p ${port} -U ${user} -F c -b -v -f "${tempPath}" ${name}`;

        strapi.log.info(`[db-backup] Running pg_dump for database ${name}...`);

        await new Promise((resolve, reject) => {
            exec(dumpCommand, (error, stdout, stderr) => {
                if (error) reject(new Error(stderr));
                else resolve();
            });
        });

        const s3 = new AWS.S3({ accessKeyId, secretAccessKey, region });
        const fileContent = fs.readFileSync(tempPath);

        await s3
            .upload({
                Bucket: bucket,
                Key: `${prefix}${fileName}`,
                Body: fileContent,
            })
            .promise();

        fs.unlinkSync(tempPath);
        strapi.log.info(`[db-backup] Backup uploaded: s3://${bucket}/${prefix}${fileName}`);

        return `s3://${bucket}/${prefix}${fileName}`;
    },

    async cleanupOldBackups() {
        const { bucket, region, accessKeyId, secretAccessKey, prefix = 'backups/' } = aws;
        const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
        const now = Date.now();

        const s3 = new AWS.S3({ accessKeyId, secretAccessKey, region });
        const list = await s3
            .listObjectsV2({ Bucket: bucket, Prefix: prefix })
            .promise();

        const oldBackups = (list.Contents || []).filter((obj) => {
            const age = now - new Date(obj.LastModified).getTime();
            return age > retentionMs;
        });

        if (!oldBackups.length) {
            strapi.log.info('[db-backup] No old backups to clean up.');
            return;
        }

        for (const file of oldBackups) {
            await s3.deleteObject({ Bucket: bucket, Key: file.Key }).promise();
            strapi.log.info(`[db-backup] Deleted old backup: ${file.Key}`);
        }
    },
});
