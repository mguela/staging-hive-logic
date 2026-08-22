const path = require('node:path');
const { Service } = require('node-windows');

const svc = new Service({
  name: 'HiveLogic Agent',
  description: 'Runs approved, typed HiveLogic automation tasks using an outbound connection.',
  script: path.join(__dirname, '..', 'src', 'agent.js'),
  nodeOptions: ['--enable-source-maps'],
  wait: 5,
  grow: 0.5,
  maxRestarts: 10,
});
svc.on('install', () => svc.start());
svc.on('alreadyinstalled', () => console.log('HiveLogic Agent is already installed.'));
svc.install();
