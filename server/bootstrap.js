'use strict';

const cron = require('node-cron');
const backupServiceFactory = require('./services/backup');

module.exports = (strapi) => {
    const config = strapi.config.get('plugin.strapi-v5-backup', {});

    const {
        enabled = true,
        cron: cronExpr = '0 3 * * *',
        retentionDays = 7,
        database,
        aws,
    } = config;

    if (!enabled) {
        strapi.log.info('[db-backup] Plugin disabled by config');
        return;
    }

    if (!database || !aws) {
        strapi.log.error('[db-backup] ❌ Missing database or AWS configuration! Backup will not start.');
        return;
    }

    const backupService = backupServiceFactory({ strapi, database, aws, retentionDays });

    strapi.log.info(`[db-backup] ✅ Schedule: ${cronExpr}, Retention: ${retentionDays} days`);

    try {
        cron.schedule(cronExpr, async () => {
            strapi.log.info('[db-backup] 🕒 Scheduled backup job triggered.');

            try {
                await backupService.runBackup();
                await backupService.cleanupOldBackups();
                strapi.log.info('[db-backup] ✅ Backup job completed successfully.');
            } catch (err) {
                strapi.log.error(`[db-backup] ❌ Backup job failed: ${err.message}`);
                if (err.stack) strapi.log.debug(err.stack);
            }
        });
    } catch (err) {
        strapi.log.error(`[db-backup] ❌ Failed to schedule backup: ${err.message}`);
    }
};
