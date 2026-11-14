# Other machines' instances

[Back to the README](../../README.md). Part of [ticket mode](ticket-mode.md).

**Other machines' instances, from this page.** Each machine runs its own instance on its own `127.0.0.1`, with its own queue, workers,
worker limit and load check. One page can show several of them, picked from a switcher in the header. The choice is remembered in that
browser. Switching changes only what the page shows: every instance keeps working while another is shown, and one that cannot be reached
shows its reason without affecting the others. The connections file is `~/.config/agent-org/connections.json`, or
`$XDG_CONFIG_HOME/agent-org/connections.json` when that variable is an absolute path:

```json
{
  "work": { "local": true },
  "personal": { "ssh": "agents" },
  "lab": { "https": "https://agents.example.ts.net", "keyFile": "~/.agent-org/keys/lab" }
}
```

- `{ "local": true }` is this machine's instance, read with the key in its state directory. At most one connection is local. A machine
  that runs only the page can have none.
- `{ "ssh": "<target>" }` is the instance on the machine `ssh <target>` reaches, exactly as `herdr --remote` takes it, such as a `Host`
  from `~/.ssh/config` or `me@host`. It may also name `agentOrg`, the path of `agent-org` on that machine, when a non-interactive shell
  there does not find it on its `PATH`. Nothing on that machine is exposed.
- `{ "https": "<address>", "keyFile": "<path>" }` is an instance exposed on purpose behind TLS, such as on a private network. The address
  is the instance's address alone. Plain `http://` is refused unless the host is `127.0.0.1`, `localhost` or `[::1]`, because the key
  would cross the network in the clear. The key file holds a copy of that instance's `board.key`. It must be yours and mode 600, or that
  connection is refused when it is reached.
- A name is 1 to 32 letters, digits, `-` or `_`. With no file, the page shows this machine's instance alone, as
  `{ "local": { "local": true } }`. A file that is not JSON or breaks a rule above is refused, the page's service names why in its log and
  on the page, and it shows this machine's instance alone.
- A `profiles.json` in the same directory, the file this one replaced, is read as the connections file when there is no
  `connections.json`, and the log says so. Its entries are connections already. It is read until the next major version: rename it.
- The page's service holds every key in its memory. A key is not written to a log, a command line or the page, and it is sent only in the
  `x-ticket-token` header. Only a paired browser's call to `/c/<connection>/api/...` is passed on, as the instance's own `Host`, and only
  for the routes the page calls. A pairing code for a worker terminal is asked for only by the page's service, for a paired browser following
  a worker link, and only from that connection's own instance. A connection that cannot be reached is shown on the page as
  `cannot reach <connection> <how>: <reason>`.

**Connect a second machine over SSH.** The page's service opens the SSH connection itself. It runs
`ssh <target> agent-org ticket:remote-info` once per connection, which prints that instance's port, key and terminal address as JSON. It
then holds `ssh -N` open, forwarding a Unix socket in a directory only you can enter to that instance's port, and a free port on this
machine's `127.0.0.1` to its terminal service. Both run with `BatchMode=yes` and no TTY, so a key that needs a passphrase not held in an
agent fails rather than waits. They share no connection, agent or X11 forwarding from your ssh config. A tunnel that drops is opened
again, after 2 seconds and up to a minute between tries. Every tunnel closes when the service exits, unless it is killed with `SIGKILL`,
which leaves its `ssh` processes running. Open terminal on that machine's runs goes through the same SSH connection when its
`tickets.terminal` is on its own `127.0.0.1` or `localhost`. Any process on this machine can reach that forwarded port while the tunnel
is open, as it can reach the remote's own terminal service from that machine.

That machine needs four things. This machine reaches it with `ssh <target>` and no prompt, through a key in an agent or one with no
passphrase. agent-org is installed there, and a non-interactive `ssh <target> agent-org ticket:remote-info` finds it and its host file,
which it does with no `AGENT_ORG_HOST` once that machine has been onboarded (see "[The host file without `AGENT_ORG_HOST`](onboard.md)" in Onboard). Its instance is
running, with `agent-org ticket:serve`. Its instance has made its key, which its first start does. `ticket:remote-info` refuses to print
the key to a terminal. Check the whole path from this machine with `ssh <target> agent-org ticket:remote-info > /dev/null && echo ok`,
which prints `ok` and not the key.

**Connect a second machine over https.** An instance stays on `127.0.0.1` unless you expose it on purpose, behind TLS, on a network you
trust, such as a private network. The TLS proxy in front of it must send the instance `Host: 127.0.0.1:<port>`, as nginx's
`proxy_pass` does by default, because the instance refuses any other host. A proxy that passes the original host on is refused. Copy that machine's `<stateDir>/tickets/board.key` to this one,
`chmod 600` it, and name it as the connection's `keyFile`. Anyone who can reach the address and holds the key can drive that instance, so
keep the address off the public internet. Open terminal on that machine's runs shows only when its `tickets.terminal` is not on its own
loopback.
