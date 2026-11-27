#!/bin/bash
set -euo pipefail
umask 077
mkdir -p /root/.ssh /var/lib/piaroute/backups
chmod 700 /root/.ssh /var/lib/piaroute/backups
cat > /root/.ssh/authorized_keys << 'EOF'
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ6A9hC1+dgoWYT+JrQXKgaPPxPEVQxrJkQR3eC+8Y8L piaroute-ana
command="/usr/bin/rrsync -wo /var/lib/piaroute/backups",restrict ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMWI8c6RemR3OOKcuYGW7vk1kpS93EaLkuWzHu38pFg1 piaroute-backup
EOF
chmod 600 /root/.ssh/authorized_keys
printf '%s\n' 'PasswordAuthentication no' > /etc/ssh/sshd_config.d/50-cloud-init.conf
mkdir -p /etc/cloud/cloud.cfg.d
printf '%s\n' 'ssh_pwauth: false' > /etc/cloud/cloud.cfg.d/99-disable-password.cfg
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?KbdInteractiveAuthentication.*/KbdInteractiveAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
sshd -t
systemctl reload ssh
echo sshd-reloaded
