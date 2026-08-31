#!/bin/bash
#
# EC2 user data for the AWS Academy sandbox, where every resource is destroyed when the
# lab session ends. Paste this into Advanced details > User data when launching the
# instance, and it provisions itself on first boot with no SSH needed.
#
# Progress and failures land in /var/log/cloud-init-output.log on the instance.

set -euxo pipefail

REPO=https://github.com/pisondev/monolithic-stateful-baseline.git
APP=/home/ec2-user/monolithic-stateful-baseline

# node:sqlite needs Node 22 exactly: it is absent before 22.5 and the flag it requires is
# gone from 23 onward, so the distribution package is not trusted to be the right major
curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
dnf install -y nodejs git

node -v | grep -q '^v22\.' || { echo "wrong node major: $(node -v)"; exit 1; }

sudo -u ec2-user git clone "$REPO" "$APP"

# the service confines writes to this directory and refuses to start if it is missing,
# and it cannot create the directory itself because the rest of home is read-only there
sudo -u ec2-user mkdir -p "$APP/data"

install -m 644 "$APP/docs/puisi.service" /etc/systemd/system/puisi.service
systemctl daemon-reload
systemctl enable --now puisi

# a marker the runbook can check to tell "still booting" apart from "boot failed"
systemctl is-active --quiet puisi && touch /home/ec2-user/PROVISIONED
