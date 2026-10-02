<<<<<<< HEAD
# connect
=======
# Shared file portal

A small website that runs on one Windows computer and stores the files on that computer. Other computers on the same local network open it in a browser. Nothing is uploaded to a cloud service, and the portal does not need an internet connection after it is installed.

People sign in with their own username and password. Anyone who is signed in can browse, search, and download every shared file. Only the person who uploaded a file can delete it.

Each file can be up to **2 GB**. The portal holds up to **50 GB** in total. Both limits are set in `.env`.

Folder uploads, previews, resumable uploads, and sharing links are not part of this version.

## How it is put together

The browser talks only to this computer. One Node.js process serves the website and the API. Files are streamed to and from a folder on disk. Names, owners, and sizes live in a SQLite database next to that folder. The website files that the server sends are the built React app. They are not loaded from a public CDN.

```
browser on another PC
        |
        |  HTTPS on the LAN (HTTP only while developing on this PC)
        v
Express on this Windows PC
   |-- session cookie + CSRF header
   |-- SQLite database (users, sessions, file records)
   `-- storage folder (one generated id per finished file)
```

A file appears in the list only after the upload finishes and the size is checked. The bytes are written to a temporary file first, then the database reserves the space, then the file is moved into place and marked ready.

If the process stops in the middle:

- A temporary upload is deleted the next time the server starts. It is not listed.
- A file that was fully written but not yet marked ready is published on the next start, when its size matches the database.
- A database row whose file is missing, or whose size does not match, is removed.
- A file on disk with no database row is removed.
- Finished files and accounts stay available after a restart. Sessions are in the same database, so a person who was signed in can stay signed in until the session expires.

Uploaded files are stored by a generated id. The original filename is kept in the database and shown in the browser. It is never used as a folder path. Downloads are sent as attachments with a generic file type, so the browser saves them instead of showing uploaded HTML as part of this site.

## What you need

- Windows 10 or 11
- Node.js 24, including npm. The server uses Node’s built-in SQLite
- This project folder
- No extra database server and no cloud account

Check the install:

```powershell
node -v
npm -v
```

`node -v` should print v24 or newer.

## First-time setup on this computer

Open PowerShell and go to the project folder. The examples below use `C:\Users\USER\Downloads\Connect`. Use your own path.

```powershell
cd C:\Users\USER\Downloads\Connect
npm install
Copy-Item .env.example .env
```

Create a session secret and paste it into `.env` as `SESSION_SECRET`:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Leave `HOST=127.0.0.1` until you are ready for other computers. Build the site, create the first account, and start it:

```powershell
npm run build
$env:PORTAL_NEW_PASSWORD = Read-Host "Password for the new user"
npm run create-user -- ada
Remove-Item Env:PORTAL_NEW_PASSWORD
npm start
```

Passwords must be 10 to 72 characters. The password is not printed back. Usernames are 3 to 32 characters: letters, numbers, periods, underscores, and hyphens.

Open `http://127.0.0.1:3000` on this same computer and sign in. This address does not work from another computer. That is intentional.

Create more people the same way, with a different username. You can do that while the server is running.

## Development on this computer

`npm run dev` starts the API at `http://127.0.0.1:3000` and the website at `http://127.0.0.1:5173`. Use the 5173 address while developing. It still talks only to this PC, and it does not use HTTPS. Do not point other computers at the dev server.

`npm start` is the mode to use once the site is built. It serves the website and the API on one port.

## Let another computer on the LAN open it

Do this only after sign-in works on this PC.

### 1. Find this computer’s LAN address and MAC address

```powershell
Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike "127.*" } |
  Select-Object InterfaceAlias, IPAddress

Get-NetAdapter | Where-Object Status -eq "Up" | Select-Object Name, MacAddress
```

Use the address on your home or office network, often `192.168.x.x` or `10.x.x.x`. The other computer will use that address. `127.0.0.1` always means “this computer,” so it will not work from a laptop across the room.

Example: if this PC’s address is `192.168.1.50`, the other computer opens `https://192.168.1.50:8443`.

### 2. Keep that address from changing

Home routers give out addresses with DHCP, and a reboot can give this PC a new one. A DHCP reservation tells the router “this MAC address always gets this IP address.”

In the router’s admin page, look for DHCP reservation, “static lease,” or “address reservation.” Enter the MAC address from the command above and the IP address you want to keep, such as `192.168.1.50`. Save it, then renew the PC’s address or reboot it and check `Get-NetIPAddress` again.

This is a setting on the router for your own LAN. It is not a port forward, and it does not expose the portal to the internet.

### 3. Create an HTTPS certificate

Other computers must use HTTPS. The server will refuse to listen on a network address without a certificate.

Run this on the server PC, with the LAN address you just chose:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\new-certificate.ps1 -LanIp 192.168.1.50
```

The script writes:

- `data\certs\portal.pfx` — the private key. Leave it on this PC only.
- `data\certs\portal.cer` — the public certificate. Copy this file to the other computers.

Edit `.env`:

```text
HOST=0.0.0.0
PORT=8443
HTTPS_PFX_PATH=data/certs/portal.pfx
HTTPS_PFX_PASSPHRASE=the-passphrase-you-typed
SESSION_SECRET=the-secret-you-generated
```

`HOST=0.0.0.0` means “accept connections on this PC’s network cards.” It does not by itself allow the internet in. Your router still has to block unsolicited inbound traffic, which it does unless someone turns on port forwarding. Do not forward port 8443.

Trust the certificate on the server PC so its own browser stops warning you:

```powershell
Import-Certificate -FilePath .\data\certs\portal.cer -CertStoreLocation Cert:\CurrentUser\Root
```

Windows will ask you to confirm. Copy `portal.cer` to each other computer (a USB stick is fine) and run that same import there, in that person’s Windows account. Do not copy `portal.pfx`.

If a browser says the certificate is untrusted or the name does not match, stop and fix the certificate. Do not use “continue anyway.” A warning means the browser cannot tell this server from an impostor on the network.

Then rebuild is unnecessary for a config change. Start the server again:

```powershell
npm start
```

On the other computer, open `https://192.168.1.50:8443` (your address and port). Sign in with an account you created.

### 4. Allow the port through Windows Firewall, privately

The first time Node listens, Windows may ask whether to allow it. Choose private networks only.

Or add a single rule yourself. Open PowerShell as Administrator:

```powershell
cd C:\Users\USER\Downloads\Connect
powershell -ExecutionPolicy Bypass -File .\scripts\allow-private-lan.ps1
```

That rule allows inbound TCP on the port in `.env`, and only while the network is classified as Private. Check the classification:

```powershell
Get-NetConnectionProfile
```

A home or office LAN should be Private. A cafe, hotel, or guest Wi-Fi should stay Public. The rule does not apply on Public networks, and that is what you want.

Do not turn the firewall off. Do not create an “any port” rule. Do not add this port to the router’s port-forwarding page.

### 5. Start it again after Windows restarts

The portal runs in the signed-in user’s account so it can read the storage folder. This task starts it about 30 seconds after that user signs in:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\register-logon-task.ps1
```

Sign in after a reboot, or leave that account signed in on a computer you use as the server. The task does not run as SYSTEM, and it does not start while the user is signed out.

Remove it later with:

```powershell
Unregister-ScheduledTask -TaskName SharedFilePortal -Confirm:$false
```

You can also start it by hand with `.\scripts\start-portal.ps1`.

## Settings

| Setting | Meaning |
| --- | --- |
| `HOST` | `127.0.0.1` for this PC only. `0.0.0.0` when other computers on the LAN should connect. |
| `PORT` | `3000` for local development. `8443` is a sensible LAN port. |
| `STORAGE_DIR` | Folder that holds the files. Keep it outside the website folders. |
| `DATABASE_PATH` | SQLite file for accounts, sessions, and file records. |
| `MAX_FILE_BYTES` | Per-file limit. Default `2147483648` (2 GB). |
| `MAX_STORAGE_BYTES` | Total finished and in-progress files. Default `53687091200` (50 GB). |
| `SESSION_SECRET` | Long random string. Required before other computers connect. |
| `SESSION_TTL_HOURS` | How long a sign-in lasts. Default 12. |
| `HTTPS_PFX_PATH` / `HTTPS_PFX_PASSPHRASE` | Certificate for LAN use. |
| `HTTPS_KEY_PATH` / `HTTPS_CERT_PATH` | Use these instead of a PFX if you already have a PEM key and certificate. |

Paths in `.env` can be relative to the project folder or full Windows paths. Do not commit `.env`, the certificate, or the `data` folder.

## Commands

```powershell
npm install
npm run build
npm start
npm test
npm run dev
npm run create-user -- username
```

`npm test` runs the automated checks. It does not need the server to be started first.

## Using the website

1. Sign in.
2. Drop files onto the page or choose them. Several files can upload at once, each with its own progress. Cancel stops that file.
3. Search by filename. Sort by name, size, or date.
4. Download uses the browser’s normal download. The file is not loaded into a script first.
5. Delete is offered only for files you uploaded. The server checks that again; hiding the button is not the only check.
6. The bar at the top shows how much of the 50 GB is in use.

An empty list, a loading line, a success note, and the server’s error text are shown on the page. A file that is too large, a full portal, a full disk, or a lost connection is reported as a failed upload and is not added to the list.

## API

All `/api` routes require a signed-in session except `POST /api/auth/login`.

| Method | Path | What it does |
| --- | --- | --- |
| `POST` | `/api/auth/login` | Body `{ "username", "password" }`. Sets an HttpOnly session cookie. |
| `POST` | `/api/auth/logout` | Ends the session. Requires the `X-CSRF-Token` header. |
| `GET` | `/api/auth/me` | Current person, CSRF token, and size limits. |
| `GET` | `/api/files?q=&sort=name\|size\|date&order=asc\|desc` | Shared files plus storage used. |
| `POST` | `/api/files` | Multipart upload, field name `file`. Requires `X-CSRF-Token`. |
| `GET` | `/api/files/:id/download` | Streams the file as a download. |
| `DELETE` | `/api/files/:id` | Deletes a file the signed-in person uploaded. Requires `X-CSRF-Token`. |

The cookie is `HttpOnly` and `SameSite=Strict`. On HTTPS it is also `Secure`. State-changing requests must send the CSRF token from the login or session response.

## Database

```sql
users (id, username, password_hash, created_at)
sessions (sid, sess, expired)
files (id, owner_id, original_name, size_bytes, created_at, state)
```

`state` is `staging` while a finished upload is being published, then `ready`. The list and downloads only use `ready`. Passwords are stored as bcrypt hashes. Session cookies and passwords are not written to the log.

## Tests

```powershell
npm test
```

The automated tests cover sign-in, anonymous requests, upload, list, search, sort, download, duplicate names, empty files, Unicode names, Windows device names such as `con.txt`, path-style filenames, HTML forced to download, uploader-only deletion, CSRF, size and storage limits, repeated bad passwords, upload concurrency, a simulated full disk, a storage path that is not a folder, restart, crash cleanup, an aborted upload, a streamed multi-megabyte file, and creating a user from the command line.

They do not fill a real disk, and they do not open a second physical computer. Trying the site from another computer on your LAN is a manual check: trust `portal.cer` there, open `https://<this-pc-lan-ip>:8443`, sign in, upload a file, and download it back.

## Layout

```text
client/     React website
server/     API, database, and file storage
scripts/    Certificate, firewall, startup, and sign-in task
data/       Created locally for the database, files, and certificate. Not part of the source.
```

## Troubleshooting

- **Other computers cannot connect.** Use the LAN IP, not `127.0.0.1`. Check `HOST=0.0.0.0`, that the server is running, and that the firewall rule is for the Private profile. Confirm both computers are on the same network.
- **The address worked yesterday and not today.** The DHCP address changed. Add the reservation described above.
- **The browser warns about the certificate.** Import `portal.cer` into Trusted Root Certification Authorities for the user who is browsing. The address in the browser must be the IP or name you put in the certificate.
- **Port already in use.** Change `PORT` in `.env`, or stop the other program.
- **The server cannot write files.** `STORAGE_DIR` must be a folder this Windows user can write to. The default is `data\storage` inside the project.
- **A large upload fails on a slow Wi-Fi link.** The server allows a long upload, up to two hours. The per-file limit is still 2 GB.
>>>>>>> c151b91 (Feat: Implement error handling in file upload and enhance test cases for upload limits)
