# Voice Bot

A Discord bot for managing temporary voice rooms.

The bot helps keep voice channels organized by assigning available rooms when users need them, then returning those rooms to a reusable pool when they are empty.

## Features

- Temporary voice room management
- Admin setup through Discord commands
- Room owner controls
- Optional moderation controls
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
- The bot needs the usual permissions for managing voice channels and moving members.
- Private tokens, local state, and server-specific settings should stay out of Git.
