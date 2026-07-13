# Discord Voice Category Mover Bot

This bot watches configured request voice channels. When a member joins one, the bot moves an available archived voice channel into the matching active category and moves the member into it. When the room becomes empty, it moves the channel back to the archive category.

## Setup

1. Create your bot on the Discord Developer Portal and copy its token.
2. Create a `.env` file from `.env.example` and add your token and client ID:

   ```bash
   cp .env.example .env
   ```

   Then set:

   ```env
   DISCORD_TOKEN=your-bot-token-here
   CLIENT_ID=your-client-id-here
   ```

3. Install dependencies:

   ```bash
   npm install
   ```

4. Start the bot:

   ```bash
   npm start
   ```

5. In Discord, run `/setup` as an admin and choose:

   - the request voice channel
   - the active category
   - the archive category containing the pool of spare voice channels

Run `/setup` again for each request channel/category group you want to add.

## Discord Commands

- `/help`: shows the commands the user can run based on their permissions and current room ownership.
- `/setup`: opens the setup menu for admins.
- `/setup-list`: shows saved setups for the server.
- `/setup-check`: checks saved setups for missing channels, empty archive pools, and bot permission problems.
- `/setup-autocreate`: enables or disables automatic archive room creation for a setup.
- `/setup-remove`: removes a saved setup.
- `/userlimit`: lets the active room owner post the user-limit selector again.
- `/transfer`: lets the active room owner transfer ownership to another member in the same room.
- `/rename`: lets the active room owner rename their room until it returns to archive.
- `/rooms`: shows active rooms and available archived rooms.
- `/logs`: lets moderators set, check, enable, or disable the voice activity and moderator audit logging channel.
- `/mr help`: shows the moderator room command menu.
- `/mr transfer`: lets moderators transfer ownership of a managed active room. The room picker only suggests active rooms created from the archive pool.
- `/mr rename`: lets moderators rename a managed active room.
- `/mr userlimit`: lets moderators change the user limit for a managed active room.
- `/mr lock`: lets moderators stop new users joining a managed active room.
- `/mr unlock`: lets moderators restore a locked managed room's previous permissions.
- `/mr close`: lets moderators return an empty managed room to archive.

Setup and command responses are visible in the server. Setup menus can only be used by the admin who opened them.
Command help, setup screens, room status, logs, and confirmations are sent as image cards instead of Discord embeds.
When a room owner leaves, the bot automatically picks a new owner and posts a handoff notice with owner controls. Only the current room owner can use those controls.
Slash commands are registered globally. Discord may take a little while to show global command changes everywhere.

## Notes

- `config.json` is no longer required for normal setup. If an old `config.json` exists, the bot will migrate valid entries into `state.json`.
- The bot creates `state.json` to remember server setups and active room owners across restarts.
- Voice activity and moderator audit logging settings are saved in `state.json`. Members with Manage Server, Manage Channels, or Moderate Members can change them with `/logs`.
- Moderator overrides only work on active voice rooms that are currently managed by the bot.
- Successful `/mr` moderator actions are audited as image cards to the saved log channel when logging is enabled.
- Auto-create is configured per setup and only creates rooms up to the saved maximum.
- Renamed active rooms return to their original archived name when moved back to archive.
- The bot requires the `Guilds` and `GuildVoiceStates` intents.
- The bot must have permission to manage channels, move members, view channels, connect, send messages, and attach files.
- Keep request voice channels separate from the archived pool channels.
