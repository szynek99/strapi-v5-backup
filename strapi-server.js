'use strict';

module.exports = {
    register() {},
    bootstrap({ strapi }) {
        require('./server/bootstrap')(strapi);
    },
};
