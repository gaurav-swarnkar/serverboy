// Team permissions and which API routes need them. The owner (super admin) can do everything;
// team members can only do what their permissions allow. Anything not listed is owner-only.

const PERMISSIONS = [
  { id: 'databases', label: 'Databases', description: 'Create and manage MariaDB / MongoDB databases, users and data.' },
  { id: 'sites', label: 'Websites', description: 'Create websites, enable SSL, enable/disable and delete sites.' },
  { id: 'files', label: 'Website files', description: 'File manager limited to website folders in /var/www (no admin rights).' },
  { id: 'services', label: 'Services', description: 'View service logs and start / stop / restart services.' },
  {
    id: 'nodeapps',
    label: 'Node apps',
    description: 'Deploy and manage Node.js apps. Runs build/start commands as the server user, so this is effectively full server access.',
    fullAccess: true,
  },
  { id: 'terminal', label: 'Terminal', description: 'Full shell on the server. Effectively full server access.', fullAccess: true },
  {
    id: 'system',
    label: 'System',
    description: 'Install / uninstall software, firewall, system updates, reboot, kill processes.',
    fullAccess: true,
  },
];

const PERMISSION_IDS = PERMISSIONS.map((p) => p.id);

const PRESETS = {
  developer: ['databases', 'sites', 'files', 'services'],
  viewer: [],
};

const OWNER = 'owner';

// Rules for /api/servers/:id/* paths: [method or '*', path regex, permission | null (anyone) | OWNER].
const SERVER_RULES = [
  ['GET', /^\/(stats|health|jobs|jobs\/[^/]+|services|apps|firewall)$/, null],
  ['*', /^\/health\//, 'services'], // diagnose + fixes (fixes also check their own permission)
  ['*', /^\/services\//, 'services'],
  ['*', /^\/(processes|reboot|system-update|apps|packages|firewall|storage)(\/|$)/, 'system'],
  ['POST', /^\/files\/chown$/, OWNER],
  ['*', /^\/files\//, 'files'],
  ['*', /^\/mongo\/(secure|credentials)$/, OWNER],
  ['*', /^\/(mysql|mongo)\//, 'databases'],
  ['PUT', /^\/sites\/[^/]+\/config$/, OWNER],
  ['*', /^\/sites(\/|$)/, 'sites'],
  ['*', /^\/node-apps(\/|$)/, 'nodeapps'],
];

function requiredForServerRoute(method, path) {
  for (const [m, re, perm] of SERVER_RULES) {
    if ((m === '*' || m === method) && re.test(path)) return perm;
  }
  return OWNER;
}

function can(user, permission) {
  if (!user) return false;
  if (permission === null) return true;
  if (user.isOwner) return true;
  if (permission === OWNER) return false;
  return user.permissions.includes(permission);
}

function cleanPermissions(list) {
  return [...new Set((Array.isArray(list) ? list : []).filter((p) => PERMISSION_IDS.includes(p)))];
}

module.exports = { PERMISSIONS, PERMISSION_IDS, PRESETS, OWNER, requiredForServerRoute, can, cleanPermissions };
