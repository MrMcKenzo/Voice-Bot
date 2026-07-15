# Voice Bot

A Discord bot for managing temporary voice rooms.

The bot helps keep voice channels organized by assigning available rooms when users need them, then returning those rooms to a reusable pool when they are empty.

## Features

- Temporary voice room management
- Admin setup through Discord commands
- Room owner controls
- Voice XP profiles and leaderboards
- XP rank role rewards using Discord roles named after the XP ranks
- Optional moderation controls
- Moderator room notes and action history
- Persistent local configuration between restarts

## Requirements

- Node.js
- npm
- A Discord bot application

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create your environment file:

   ```bash
   cp .env.example .env
   ```

3. Add your Discord bot details to `.env`.

4. Start the bot:

   ```bash
   npm start
   ```

5. Invite the bot to your Discord server and use the in-server setup command as an administrator.

## Configuration

Runtime configuration is stored locally and is not committed to the repository. Keep your `.env` file private.

## Notes

- Use the bot's Discord help command to see available commands.
- Use `/xp-roles` after creating rank roles to backfill existing members. Rank role names should match the XP ranks, such as `New Voice`, `VC Regular`, `Rookie Host`, and `Room Starter`.
- Moderators can use `/mr note` and `/mr history` to keep room-specific context alongside audit logs.
- The bot needs the usual permissions for managing voice channels, moving members, and managing XP rank roles.
- Private tokens, local state, and server-specific settings should stay out of Git.
