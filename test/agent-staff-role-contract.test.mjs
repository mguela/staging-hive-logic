import assert from 'node:assert/strict';
import fs from 'node:fs';

const security = fs.readFileSync(new URL('../api/_lib/agents/security.js', import.meta.url), 'utf8');

assert.match(
  security,
  /requireStaff\(req, allowedRoles = \['admin', 'superadmin'\]\)/,
  'administrative agent and Council endpoints must accept both HiveLogic administrator roles',
);

console.log('agent staff-role contract tests passed');
