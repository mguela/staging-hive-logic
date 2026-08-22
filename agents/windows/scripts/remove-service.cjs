const path = require('node:path');
const { Service } = require('node-windows');
const svc = new Service({ name: 'HiveLogic Agent', script: path.join(__dirname, '..', 'src', 'agent.js') });
svc.on('uninstall', () => console.log('HiveLogic Agent service removed.'));
svc.uninstall();
