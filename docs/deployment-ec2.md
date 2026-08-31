# Deployment on AWS EC2

Target: **t2.micro**, Amazon Linux 2023, port **8080** open to the public. The application
and its database live on that single instance, which is the point of the assignment.

## 0. The environment this is written for

The lab is the **AWS Academy Cloud Developing Sandbox**, and its own readme is blunt about
what that means:

> This environment is NOT long-lived. When the session timer runs to 0:00, the session will
> end, and any data and resources that you created in the AWS account will be permanently
> deleted.

Nothing survives a session. Not the instance, not the database, not an Elastic IP. So this
runbook is not written to be followed once and left running. It is written to be **repeated
in about ten minutes**, including on the morning of the demonstration.

That is why the instance provisions itself from `docs/user-data.sh` instead of being set up
by hand over SSH. Deployment is one launch wizard and a wait.

Two things follow:

- **The public IP changes every session.** Read it from the console on the day and use it
  then. Do not print it in the report as a permanent address.
- **The session timer can be refreshed.** Choosing *Start Lab* again before it reaches 0:00
  extends it without losing anything. During a class demonstration, keep an eye on it.

The sandbox constraints that matter here, from the same readme: only `us-east-1` and
`us-west-2`, only t2 and t3 in nano, micro and small sizes, only AMIs owned by Amazon, EBS
volumes up to 35 GB. The assignment asks for `t2.micro` in `us-east-1`, which fits.

## 1. Start the lab

In Canvas, open **AWS Academy Cloud Developing** then **Modules > Sandbox > Sandbox**.

Choose **Start Lab** and wait for the dot beside *AWS* to turn green. Choose **AWS** to open
the console in a new tab. If nothing opens, allow pop-ups for the site.

Confirm the region reads **N. Virginia (us-east-1)** in the top right. Resources created in
any other region will be invisible or refused.

## 2. Launch the instance

EC2 console, **Launch instance**.

| Field | Value |
|---|---|
| Name | `puisi-baseline` |
| AMI | Amazon Linux 2023, from the **Quick Start** tab |
| Instance type | `t2.micro` |
| Key pair | **`vockey`**, which already exists in `us-east-1` |
| Storage | 8 GB gp3, the default |

**Network settings**, choose *Edit*, then add inbound rules:

| Type | Port | Source | Why |
|---|---|---|---|
| SSH | 22 | Anywhere | The browser terminal connects from outside your own network |
| Custom TCP | 8080 | Anywhere `0.0.0.0/0` | The application, as the brief requires |

Port 8080 rather than 80 because binding below 1024 needs root, and the brief permits
either. Nothing here runs as root.

**Advanced details**, scroll to **User data**, and paste the entire contents of
`docs/user-data.sh`. That is the whole setup: it installs Node 22, clones the repository,
creates the data directory, and starts the service on first boot.

Launch it.

## 3. Wait, then check

Provisioning takes roughly two to four minutes after the instance reaches *Running*. Most of
it is installing Node.

Copy the **Public IPv4 address** from the instance page, then from your own machine:

```bash
IP=<public-ipv4>
curl -s -o /dev/null -w '%{http_code}\n' http://$IP:8080/
```

`200` means it is live. Open `http://IP:8080/` in a browser and use the page.

Nothing yet? It is either still booting or it failed. Tell the two apart from the terminal
beside the lab instructions, which already holds the key:

```bash
ssh -i ~/.ssh/labsuser.pem ec2-user@<public-ip>

ls PROVISIONED                      # exists only if provisioning finished cleanly
sudo tail -40 /var/log/cloud-init-output.log   # what user data actually did
systemctl status puisi
journalctl -u puisi -n 40
```

Windows users need no PuTTY and no key file. The lab terminal is the simplest way in.

Expected journal lines:

```
listening on http://localhost:8080/server.js?aksi=
database /home/ec2-user/monolithic-stateful-baseline/data/app.db, foreign keys on
sessions in memory, ttl 1800000 ms, lost on restart
```

## 4. Check the whole flow from outside

Run this from your own machine rather than the instance, so the security group is exercised
too.

```bash
IP=<public-ipv4>

curl -s -X POST "http://$IP:8080/server.js?aksi=register" \
  -d 'username=demo&nama=Demo&password=rahasia123'
curl -s -c jar.txt -X POST "http://$IP:8080/server.js?aksi=login" \
  -d 'username=demo&password=rahasia123'
curl -s -b jar.txt "http://$IP:8080/server.js?aksi=daftar_puisi"
```

Then open the page in a browser with the **Network** tab open. Confirm that login carries a
`Set-Cookie: SID=...` response header, and that every later request carries a matching
`Cookie` request header. Those two screenshots are what the assignment asks students to
observe, and they are worth capturing before the demonstration rather than during it.

## 5. The demonstration

Rehearse this. It is the evidence the whole assignment is built around.

1. Log in through the browser. Submit a poem. Confirm it appears in the list.
2. Note the footer: hostname, **pid**, uptime, and the live session count.
3. Over SSH, run `sudo systemctl restart puisi`.
4. Reload the page without clearing anything.

| Observation | Point |
|---|---|
| The pid changed and uptime reset | A different process is serving now |
| The session count dropped to zero | Session state lived only in the old process memory |
| The page shows the login form again | The browser still holds and still sends the cookie; the server no longer knows it |
| Logging back in shows the same poems | The database was never touched |

The last row is the one to land on. Data survived on disk, state did not, and no amount of
correct code prevents that while sessions live in one machine's RAM. A second instance
behind a load balancer would fail the same way with no restart at all.

To show expiry instead of a restart, shorten the lifetime and reload:

```bash
sudo systemctl set-environment SESSION_TTL_MS=15000
sudo systemctl restart puisi
```

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Nothing on 8080 a few minutes in | Still installing Node, or user data failed | `ls PROVISIONED`, then read `/var/log/cloud-init-output.log` |
| `wrong node major` in the boot log | NodeSource served a different version | Install Node 22 by hand, then `sudo systemctl restart puisi` |
| `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite` | Node older than 22.5 | Same as above |
| `bad option: --experimental-sqlite` | Node 23 or newer, where the flag was removed | Same as above |
| `SQLITE_CANTOPEN`, or a namespace error on start | The `data` directory is missing | `mkdir -p ~/monolithic-stateful-baseline/data`, then restart the service |
| Connection refused from outside, fine over SSH | Security group | Open TCP 8080 to `0.0.0.0/0` |
| Console shows access denied everywhere | Wrong region | Switch to `us-east-1` |
| Everything vanished between sessions | The sandbox deleted it, as documented | Relaunch. This is why the setup is one paste of user data |
| Logged out on every page load | `COOKIE_SECURE=1` without TLS in front | Leave it off while serving plain HTTP |

## 7. Budget

The lab has a fixed credit shown above the instructions, and it updates only every eight to
twelve hours, so the figure lags. Running out disables the account and destroys everything
in it.

`t2.micro` is cheap, but an instance left running through a session you are not using still
spends. Choose **End Lab** when you finish for the day. Everything is deleted either way, so
there is nothing to preserve by leaving it up.
