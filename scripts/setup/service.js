// Service files with this install's real paths. Pure. Exit 78 means a person is needed, so
// neither restarts on it.
import os from 'node:os';
import path from 'node:path';

/** ProtectHome blocks an install under /home, which is where most of them live. */
export function renderSystemUnit({ root, node, user }) {
  const underHome = root.startsWith(`${os.homedir()}${path.sep}`) || root.startsWith('/home/') || root.startsWith('/root/');
  return `[Unit]
Description=Karyasthan WhatsApp Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${user}
ExecStart=${node} ${path.join(root, 'src/index.js')}
WorkingDirectory=${root}
Restart=always
RestartSec=10
RestartPreventExitStatus=78
TimeoutStopSec=30
Environment=NODE_ENV=production
NoNewPrivileges=true
ProtectSystem=strict
${underHome ? 'ProtectHome=false' : 'ProtectHome=true'}
ReadWritePaths=${root}
PrivateTmp=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true

[Install]
WantedBy=multi-user.target
`;
}

export function renderUserUnit({ root, node }) {
  return `[Unit]
Description=Karyasthan WhatsApp Agent
After=network-online.target

[Service]
Type=simple
ExecStart=${node} ${path.join(root, 'src/index.js')}
WorkingDirectory=${root}
Restart=always
RestartSec=10
RestartPreventExitStatus=78
TimeoutStopSec=30
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
`;
}
