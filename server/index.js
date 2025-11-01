'use strict';

const bootstrap = require('./bootstrap');
const backup = require('./services/backup');

module.exports = {
    bootstrap,
    services: {
        backup,
    },
};
