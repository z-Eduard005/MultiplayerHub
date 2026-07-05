# MultiplayerHub

A decentralized Minecraft server provisioning tool. No dedicated host required — the first player to run the binary becomes host, others auto-join, and if the host drops, someone else takes over.

## How it works

Start the binary, pick an option:

- **Create Instance** — set up accounts, deploy infrastructure, create a server instance, share the encoded string with friends
- **Join Server** — select from known servers; auto-host if no one is hosting, or auto-join if someone already is
- **Join New Server** — paste an encoded string from the admin to add a server to your list

**Completely free** Everything runs on your machine. No servers to rent, no subscriptions, no hidden costs.  
**Only limitation** is your github free plan which affect only world size. So if your world is very big (commit size bigger then 2GB or one commit file bigger then 100MB), github will reject pushes and your world will not be synced!