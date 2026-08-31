# Deployment on AWS EC2

Target: **t2.micro**, Amazon Linux 2023, port **8080** open to the public. The application
and its database live on that single instance, which is the point of the assignment.

> The unit file and the commands below were written against Amazon Linux 2023 but could not
> be executed from the development machine, which runs Windows. Treat the first run as the
> real test and work through the troubleshooting table if a step behaves differently.

## 1. Instance

| Setting | Value |
|---|---|
| Type | `t2.micro` |
| AMI | Amazon Linux 2023 |
| Storage | 8 GB gp3, the default |
| Key pair | Create and download it, there is no second chance |

**Attach an Elastic IP before doing anything else.** A plain public IP is released whenever
the instance stops, and the deliverable is a live address demonstrated in class. Losing it
the night before means reissuing the link in the report.

## 2. Security group

Inbound only. Everything else stays closed.

| Type | Port | Source | Why |
|---|---|---|---|
| SSH | 22 | Your own IP | Administration. Never `0.0.0.0/0` |
| Custom TCP | 8080 | `0.0.0.0/0` | The application, as the brief requires |

Port 8080 rather than 80 because binding a port below 1024 needs root, and the brief permits
either. Nothing here runs as root.

## 3. Node.js 22

The application needs **Node 22.5 or newer, below 23**. `node:sqlite` is built in from 22.5
but still requires `--experimental-sqlite`, and Node 23 removes the flag rather than
ignoring it, so the major version matters.

```bash
# check whether the distribution already carries a suitable build
dnf list --available 'nodejs*'

# otherwise pin it through NodeSource
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
sudo dnf install -y nodejs git

node -v    # must report v22.x
```

If `node -v` reports v20 or v23, stop and fix it here. Every later step will fail in a way
that points somewhere else.

## 4. Application

```bash
cd /home/ec2-user
git clone https://github.com/pisondev/monolithic-stateful-baseline.git
cd monolithic-stateful-baseline

npm test      # 18 cases, all should pass on the instance too
mkdir -p data # required, see below
```

There is no install step. `dependencies` is empty, so there is nothing to fetch and no
lockfile to install from. `npm ci` would fail here for exactly that reason, which is worth
knowing before it looks like a broken clone.

Running the suite on the instance is worth the thirty seconds. It is the fastest way to
learn that the Node version is wrong before a class demonstration does it for you.

**The `data` directory has to be created by hand.** It is gitignored, so a fresh clone does
not contain it, and the tests never need it because they run against an in-memory database.
The service then locks the home directory to read-only apart from that one path, so the
application cannot create it either: `ReadWritePaths` refuses to start a unit whose path
does not exist, and even without that, `mkdir` inside the namespace would hit a read-only
filesystem. One command now, or a confusing `SQLITE_CANTOPEN` later.

## 5. Service

```bash
sudo cp docs/puisi.service /etc/systemd/system/puisi.service
sudo systemctl daemon-reload
sudo systemctl enable --now puisi

systemctl status puisi
journalctl -u puisi -f
```

The unit sets `Restart=always` with a one second delay, because restarting the service is
the demonstration and it should come back immediately. It also confines writes to the `data`
directory, so a bug cannot touch anything else on the box.

Expected first lines in the journal:

```
listening on http://localhost:8080/server.js?aksi=
database /home/ec2-user/monolithic-stateful-baseline/data/app.db, foreign keys on
sessions in memory, ttl 1800000 ms, lost on restart
```

## 6. Verify from outside

Replace `IP` with the Elastic IP. Run this from your own machine, not from the instance, so
the security group is exercised too.

```bash
IP=<elastic-ip>

curl -s -o /dev/null -w '%{http_code}\n' http://$IP:8080/
curl -s -X POST "http://$IP:8080/server.js?aksi=register" \
  -d 'username=demo&nama=Demo&password=rahasia123'
curl -s -c jar.txt -X POST "http://$IP:8080/server.js?aksi=login" \
  -d 'username=demo&password=rahasia123'
curl -s -b jar.txt "http://$IP:8080/server.js?aksi=daftar_puisi"
```

Then open `http://IP:8080/` in a browser and use the page itself. With the **Network** tab
open, check that login carries a `Set-Cookie: SID=...` response header and that every later
request carries a matching `Cookie` request header. Those two screenshots are what the
assignment asks students to observe.

## 7. The demonstration

This is the sequence worth rehearsing before class, because it is the evidence the whole
assignment is built around.

1. Log in through the browser. Submit a poem. Confirm it appears in the list.
2. Note the footer: hostname, **pid**, uptime, and the live session count.
3. On the instance, run `sudo systemctl restart puisi`.
4. Reload the page without clearing anything.

What should happen, and what to say about it:

| Observation | Point |
|---|---|
| The pid changed and uptime reset | A different process is serving now |
| The session count dropped to zero | Session state lived only in the old process memory |
| The page shows the login form again | The browser still holds and still sends the cookie; the server no longer knows it |
| Logging back in shows the same poems | The database was never touched |

The last row is the one to land on. Data survived on disk, state did not, and no amount of
correct code prevents that as long as sessions live in one machine's RAM. Adding a second
instance behind a load balancer would produce the same failure without any restart at all.

To show expiry instead of a restart, set a short lifetime and reload:

```bash
sudo systemctl set-environment SESSION_TTL_MS=15000
sudo systemctl restart puisi
```

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite` | Node older than 22.5 | Install Node 22 as in step 3 |
| `bad option: --experimental-sqlite` | Node 23 or newer, the flag was removed | Downgrade to Node 22 |
| Service restarts in a loop | Read the cause first: `journalctl -u puisi -n 50` | Usually the wrong Node version or a missing `data` directory |
| `SQLITE_CANTOPEN`, or the unit refuses to start with a namespace error | The `data` directory does not exist, or `ReadWritePaths` points somewhere else | `mkdir -p data`, then confirm the path in the unit matches it exactly |
| `EROFS` on startup | The service tried to create `data` under a read-only home | Same fix: create it before starting, not after |
| Page loads locally but not from outside | Security group | Open TCP 8080 to `0.0.0.0/0` |
| Connection refused from outside | Bound to the wrong interface or the service is down | `systemctl status puisi`, then `ss -tlnp \| grep 8080` |
| The public IP changed | The instance was stopped without an Elastic IP | Attach one, then update the report |
| Logged out on every page load | `COOKIE_SECURE=1` without TLS in front | Leave it off while serving plain HTTP |

## 9. Cost and shutdown

`t2.micro` is inside the free tier, but an Elastic IP is billed while it is **not** attached
to a running instance. Release it when the assignment is graded rather than leaving it
allocated.

```bash
sudo systemctl stop puisi
sudo systemctl disable puisi
```
