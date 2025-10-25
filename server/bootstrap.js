'use strict';

const cron = require('node-cron');
const backupServiceFactory = require('./services/backup');

module.exports = (strapi) => {
    const config = strapi.config.get('plugin.db-backup', {});

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
        strapi.log.error('[db-backup] Missing database or AWS configuration!');
        return;
    }

    const backupService = backupServiceFactory({ strapi, database, aws, retentionDays });

    strapi.log.info(`[db-backup] Schedule: ${cronExpr}, Retention: ${retentionDays} days`);

    cron.schedule(cronExpr, async () => {
        try {
            strapi.log.info('[db-backup] Starting backup job...');
            await backupService.runBackup();
            await backupService.cleanupOldBackups();
            strapi.log.info('[db-backup] Backup job completed.');
        } catch (err) {
            strapi.log.error(`[db-backup] Backup failed: ${err.message}`);
        }
    });
};
