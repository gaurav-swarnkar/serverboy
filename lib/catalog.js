// One-click software catalog. Scripts target Ubuntu / Debian (Azure's default images).
// `check` exits 0 when installed and may print a version line.

const APT = 'apt-get update -y && apt-get install -y';

const catalog = [
  {
    id: 'nginx',
    name: 'Nginx',
    category: 'Web server',
    description: 'Fast web server and reverse proxy. Needed for Websites and for putting Node apps on a domain.',
    check: 'command -v nginx >/dev/null && nginx -v 2>&1',
    install: `${APT} nginx && systemctl enable --now nginx`,
    uninstall: 'systemctl disable --now nginx; apt-get remove -y nginx nginx-common',
    service: 'nginx',
  },
  {
    id: 'mongodb',
    name: 'MongoDB 8.0',
    category: 'Database',
    description: 'Official MongoDB Community Server (mongod + mongosh). Listens on localhost only by default.',
    check: 'command -v mongod >/dev/null && mongod --version | head -1',
    install: `set -e
apt-get update -y && apt-get install -y gnupg curl ca-certificates
. /etc/os-release
curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc | gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor --yes
if [ "$ID" = "debian" ]; then
  echo "deb [ signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] http://repo.mongodb.org/apt/debian bookworm/mongodb-org/8.0 main" > /etc/apt/sources.list.d/mongodb-org-8.0.list
else
  CODENAME="$VERSION_CODENAME"
  case "$CODENAME" in jammy|noble) ;; *) echo "Note: $CODENAME is not officially supported, using noble packages"; CODENAME=noble;; esac
  echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu $CODENAME/mongodb-org/8.0 multiverse" > /etc/apt/sources.list.d/mongodb-org-8.0.list
fi
apt-get update -y
apt-get install -y mongodb-org
systemctl enable --now mongod
sleep 3; systemctl is-active mongod`,
    uninstall: 'systemctl disable --now mongod; apt-get purge -y "mongodb-org*"',
    service: 'mongod',
  },
  {
    id: 'mariadb',
    name: 'MariaDB',
    category: 'Database',
    description: 'MySQL-compatible database (same as on shared hosting). Manage it from the Databases page.',
    check: 'command -v mariadb >/dev/null && mariadb --version',
    install: `${APT} mariadb-server mariadb-client && systemctl enable --now mariadb`,
    uninstall: 'systemctl disable --now mariadb; apt-get remove -y mariadb-server',
    service: 'mariadb',
  },
  {
    id: 'redis',
    name: 'Redis',
    category: 'Database',
    description: 'In-memory cache / queue store, commonly used for sessions and background jobs in SaaS apps.',
    check: 'command -v redis-server >/dev/null && redis-server --version',
    install: `${APT} redis-server && systemctl enable --now redis-server`,
    uninstall: 'systemctl disable --now redis-server; apt-get remove -y redis-server',
    service: 'redis-server',
  },
  {
    id: 'nodejs',
    name: 'Node.js 22 LTS',
    category: 'Runtime',
    description: 'JavaScript runtime from NodeSource, with npm. Required for Node Apps.',
    check: 'command -v node >/dev/null && node --version',
    install: `set -e
apt-get update -y && apt-get install -y curl ca-certificates
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
node --version && npm --version`,
    uninstall: 'apt-get remove -y nodejs',
  },
  {
    id: 'pm2',
    name: 'PM2',
    category: 'Runtime',
    description: 'Process manager that keeps Node apps running and restarts them on crash or reboot.',
    check: 'command -v pm2 >/dev/null && echo "pm2 $(pm2 --version 2>/dev/null | tail -1)"',
    install: 'command -v npm >/dev/null || { echo "Install Node.js first"; exit 1; }; npm install -g pm2',
    uninstall: 'npm uninstall -g pm2',
  },
  {
    id: 'php',
    name: 'PHP-FPM',
    category: 'Runtime',
    description: 'PHP with common extensions (mysql, mbstring, xml, curl, zip, gd) for WordPress / Laravel style sites.',
    check: 'command -v php >/dev/null && php -v | head -1',
    install: `${APT} php-fpm php-mysql php-mbstring php-xml php-curl php-zip php-gd php-intl php-bcmath unzip`,
    uninstall: 'apt-get remove -y "php*-fpm"',
  },
  {
    id: 'docker',
    name: 'Docker',
    category: 'Runtime',
    description: 'Container engine with the compose plugin, via the official get.docker.com script.',
    check: 'command -v docker >/dev/null && docker --version',
    install: 'set -e; apt-get update -y && apt-get install -y curl; curl -fsSL https://get.docker.com | sh; systemctl enable --now docker',
    uninstall: 'systemctl disable --now docker; apt-get purge -y docker-ce docker-ce-cli containerd.io docker-compose-plugin',
    service: 'docker',
  },
  {
    id: 'certbot',
    name: 'Certbot (Let\'s Encrypt)',
    category: 'Security',
    description: 'Free SSL certificates with automatic renewal. Used by the "Enable SSL" button on Websites.',
    check: 'command -v certbot >/dev/null && certbot --version 2>&1',
    install: `${APT} certbot python3-certbot-nginx`,
    uninstall: 'apt-get remove -y certbot python3-certbot-nginx',
  },
  {
    id: 'ufw',
    name: 'UFW Firewall',
    category: 'Security',
    description: 'Simple host firewall. Manage rules from the Firewall page.',
    check: 'command -v ufw >/dev/null && ufw version | head -1',
    install: `${APT} ufw`,
    uninstall: 'ufw disable; apt-get remove -y ufw',
  },
  {
    id: 'fail2ban',
    name: 'Fail2ban',
    category: 'Security',
    description: 'Blocks IPs that repeatedly fail SSH logins. Strongly recommended for password-based SSH.',
    check: 'command -v fail2ban-server >/dev/null && fail2ban-server --version 2>&1 | head -1',
    install: `${APT} fail2ban && systemctl enable --now fail2ban`,
    uninstall: 'systemctl disable --now fail2ban; apt-get remove -y fail2ban',
    service: 'fail2ban',
  },
  {
    id: 'git',
    name: 'Git & build tools',
    category: 'Tools',
    description: 'git, build-essential, curl, unzip, htop: the basics for deploying from a repository.',
    check: 'command -v git >/dev/null && git --version',
    install: `${APT} git build-essential curl unzip zip htop`,
  },
];

function find(id) {
  return catalog.find((a) => a.id === id) || null;
}

// One command that reports the install state of every catalog app.
function statusScript() {
  return catalog
    .map((a) => `if out=$( { ${a.check}; } 2>/dev/null ); then echo "${a.id}|1|$(echo "$out" | head -1)"; else echo "${a.id}|0|"; fi`)
    .join('\n');
}

module.exports = { catalog, find, statusScript };
