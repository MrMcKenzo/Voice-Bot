'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');
const { PassThrough, Readable } = require('stream');
const zlib = require('zlib');
const {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ApplicationCommandType,
  AttachmentBuilder,
  ChannelSelectMenuBuilder,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
} = require('discord.js');
require('dotenv').config();

const configPath = path.join(__dirname, 'config.json');
const statePath = path.join(__dirname, 'state.json');
const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID || null;
const setupPermissionBits = PermissionFlagsBits.ManageGuild | PermissionFlagsBits.ManageChannels;
const voiceLogPermissionNames = ['ViewChannel', 'SendMessages', 'AttachFiles'];
const botPermissionBits =
  PermissionFlagsBits.ManageChannels |
  PermissionFlagsBits.ManageRoles |
  PermissionFlagsBits.MoveMembers |
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.AttachFiles |
  PermissionFlagsBits.Connect;
const hostRoomStartXp = 25;
const hostXpPerHostedMinute = 1;
const memberXpPerVoiceMinute = 1;
const memberRanks = [
  { name: 'New Voice', xp: 0 },
  { name: 'VC Regular', xp: 100 },
  { name: 'Conversation Starter', xp: 250 },
  { name: 'Room Favorite', xp: 500 },
  { name: 'Community Voice', xp: 1000 },
  { name: 'Server Socialite', xp: 2000 },
  { name: 'Voice Legend', xp: 5000 },
];
const hostRanks = [
  { name: 'Rookie Host', xp: 0 },
  { name: 'Room Starter', xp: 100 },
  { name: 'Voice Regular', xp: 250 },
  { name: 'Party Captain', xp: 500 },
  { name: 'Lounge Legend', xp: 1000 },
  { name: 'VC Royalty', xp: 2000 },
  { name: 'Eternal Host', xp: 5000 },
];
const moderatorRoomHistoryLimit = 100;
const moderatorRoomHistoryDisplayLimit = 10;

if (!token) {
  console.error('Missing DISCORD_TOKEN in .env.');
  process.exit(1);
}

const legacyConfig = loadLegacyConfig();
const botState = loadState();
ensureStateShape();
migrateLegacyConfig(legacyConfig);

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const requestChannelById = new Map();
const poolChannelArchive = new Map();
const voiceChannelOwners = new Map();
const voiceChannelPermissionSnapshots = new Map();
const setupSessions = new Map();
let botOwnerIds = new Set();
let systemFontRendererAvailable = null;
let pureImageRenderer = null;
let pureImageRendererAvailable = null;
let pureImageFontsLoaded = false;
const cardTheme = {
  accent: [249, 115, 22, 255],
  subtitle: [254, 215, 170, 255],
  label: [253, 186, 116, 255],
  panelRadius: 18,
};

const helpCommand = {
  name: 'help',
  description: 'Show bot commands and who can use them',
  type: ApplicationCommandType.ChatInput,
  dm_permission: false,
};

const guildCommands = [
  helpCommand,
  {
    name: 'userlimit',
    description: 'Send the user limit selector for your voice channel',
    type: ApplicationCommandType.ChatInput,
    dm_permission: false,
  },
  {
    name: 'transfer',
    description: 'Transfer ownership of your active voice room',
    type: ApplicationCommandType.ChatInput,
    dm_permission: false,
    options: [
      {
        name: 'member',
        description: 'The member in your voice room who should become owner',
        type: ApplicationCommandOptionType.User,
        required: true,
      },
    ],
  },
  {
    name: 'rename',
    description: 'Rename your active voice room',
    type: ApplicationCommandType.ChatInput,
    dm_permission: false,
    options: [
      {
        name: 'name',
        description: 'The new voice room name',
        type: ApplicationCommandOptionType.String,
        required: true,
      },
    ],
  },
  {
    name: 'rooms',
    description: 'Show active voice rooms and available archived rooms',
    type: ApplicationCommandType.ChatInput,
    dm_permission: false,
  },
  {
    name: 'tophosts',
    description: 'Show the top voice room hosts',
    type: ApplicationCommandType.ChatInput,
    dm_permission: false,
    options: [
      {
        name: 'limit',
        description: 'Number of hosts to show',
        type: ApplicationCommandOptionType.Integer,
        minValue: 1,
        maxValue: 25,
        required: false,
      },
    ],
  },
  {
    name: 'hostprofile',
    description: 'Show voice room host XP and streaks',
    type: ApplicationCommandType.ChatInput,
    dm_permission: false,
    options: [
      {
        name: 'member',
        description: 'Member to view, or leave blank for yourself',
        type: ApplicationCommandOptionType.User,
        required: false,
      },
    ],
  },
  {
    name: 'topmembers',
    description: 'Show the top voice room members by XP',
    type: ApplicationCommandType.ChatInput,
    dm_permission: false,
    options: [
      {
        name: 'limit',
        description: 'Number of members to show',
        type: ApplicationCommandOptionType.Integer,
        minValue: 1,
        maxValue: 25,
        required: false,
      },
    ],
  },
  {
    name: 'vcprofile',
    description: 'Show regular voice room member XP and time',
    type: ApplicationCommandType.ChatInput,
    dm_permission: false,
    options: [
      {
        name: 'member',
        description: 'Member to view, or leave blank for yourself',
        type: ApplicationCommandOptionType.User,
        required: false,
      },
    ],
  },
  {
    name: 'xp-roles',
    description: 'Sync Discord roles for current voice XP ranks',
    type: ApplicationCommandType.ChatInput,
    dm_permission: false,
    options: [
      {
        name: 'member',
        description: 'Member to sync, or leave blank to sync all known XP members',
        type: ApplicationCommandOptionType.User,
        required: false,
      },
    ],
  },
  {
    name: 'logs',
    description: 'View or change voice and moderator audit logging',
    type: ApplicationCommandType.ChatInput,
    dm_permission: false,
    options: [
      {
        name: 'channel',
        description: 'Text channel where voice activity and moderator audit logs should be sent',
        type: ApplicationCommandOptionType.Channel,
        channelTypes: [ChannelType.GuildText],
        required: false,
      },
      {
        name: 'enabled',
        description: 'Turn voice activity logging on or off',
        type: ApplicationCommandOptionType.Boolean,
        required: false,
      },
    ],
  },
  {
    name: 'mr',
    description: 'Moderator controls for bot-managed active voice rooms',
    type: ApplicationCommandType.ChatInput,
    dm_permission: false,
    options: [
      {
        name: 'help',
        description: 'Show the moderator room command menu',
        type: ApplicationCommandOptionType.Subcommand,
      },
      {
        name: 'transfer',
        description: 'Transfer ownership of any managed active voice room',
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: 'channel',
            description: 'The managed active voice room from the archive pool',
            type: ApplicationCommandOptionType.String,
            autocomplete: true,
            required: true,
          },
          {
            name: 'member',
            description: 'The member in the room who should become owner',
            type: ApplicationCommandOptionType.User,
            required: true,
          },
        ],
      },
      {
        name: 'rename',
        description: 'Rename any managed active voice room',
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: 'channel',
            description: 'The managed active voice room',
            type: ApplicationCommandOptionType.Channel,
            channelTypes: [ChannelType.GuildVoice],
            required: true,
          },
          {
            name: 'name',
            description: 'The new room name',
            type: ApplicationCommandOptionType.String,
            required: true,
          },
        ],
      },
      {
        name: 'userlimit',
        description: 'Change the user limit for any managed active voice room',
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: 'channel',
            description: 'The managed active voice room',
            type: ApplicationCommandOptionType.Channel,
            channelTypes: [ChannelType.GuildVoice],
            required: true,
          },
          {
            name: 'limit',
            description: '0 for unlimited, or 1-99 users',
            type: ApplicationCommandOptionType.Integer,
            minValue: 0,
            maxValue: 99,
            required: true,
          },
        ],
      },
      {
        name: 'lock',
        description: 'Stop new users joining any managed active voice room',
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: 'channel',
            description: 'The managed active voice room',
            type: ApplicationCommandOptionType.Channel,
            channelTypes: [ChannelType.GuildVoice],
            required: true,
          },
        ],
      },
      {
        name: 'unlock',
        description: 'Allow users to join a locked managed active voice room again',
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: 'channel',
            description: 'The managed active voice room',
            type: ApplicationCommandOptionType.Channel,
            channelTypes: [ChannelType.GuildVoice],
            required: true,
          },
        ],
      },
      {
        name: 'close',
        description: 'Return an empty managed active voice room to archive',
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: 'channel',
            description: 'The empty managed active voice room',
            type: ApplicationCommandOptionType.Channel,
            channelTypes: [ChannelType.GuildVoice],
            required: true,
          },
        ],
      },
      {
        name: 'history',
        description: 'Show recent moderator room actions and notes',
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: 'channel',
            description: 'Voice room to filter history by',
            type: ApplicationCommandOptionType.Channel,
            channelTypes: [ChannelType.GuildVoice],
            required: false,
          },
          {
            name: 'limit',
            description: 'Number of history entries to show',
            type: ApplicationCommandOptionType.Integer,
            minValue: 1,
            maxValue: moderatorRoomHistoryDisplayLimit,
            required: false,
          },
        ],
      },
      {
        name: 'note',
        description: 'Save a moderator note on a managed active voice room',
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: 'channel',
            description: 'The managed active voice room',
            type: ApplicationCommandOptionType.Channel,
            channelTypes: [ChannelType.GuildVoice],
            required: true,
          },
          {
            name: 'note',
            description: 'The note to save in room history',
            type: ApplicationCommandOptionType.String,
            required: true,
          },
        ],
      },
    ],
  },
  {
    name: 'access-role',
    description: 'Set the role that can use bot admin commands',
    type: ApplicationCommandType.ChatInput,
    default_member_permissions: setupPermissionBits.toString(),
    dm_permission: false,
    options: [
      {
        name: 'role',
        description: 'Role that can use bot admin and moderator commands',
        type: ApplicationCommandOptionType.Role,
        required: false,
      },
      {
        name: 'clear',
        description: 'Clear the saved access role',
        type: ApplicationCommandOptionType.Boolean,
        required: false,
      },
    ],
  },
  {
    name: 'setup',
    description: 'Set up an automatic voice room pool with menus',
    type: ApplicationCommandType.ChatInput,
    dm_permission: false,
  },
  {
    name: 'setup-list',
    description: 'Show the saved automatic voice room setups',
    type: ApplicationCommandType.ChatInput,
    dm_permission: false,
  },
  {
    name: 'setup-check',
    description: 'Check saved voice room setups for missing channels, empty pools, and bot permissions',
    type: ApplicationCommandType.ChatInput,
    dm_permission: false,
  },
  {
    name: 'setup-autocreate',
    description: 'Enable or disable automatic archive room creation for a setup',
    type: ApplicationCommandType.ChatInput,
    dm_permission: false,
    options: [
      {
        name: 'request-channel',
        description: 'The request voice channel for the setup',
        type: ApplicationCommandOptionType.Channel,
        channelTypes: [ChannelType.GuildVoice],
        required: true,
      },
      {
        name: 'enabled',
        description: 'Whether the bot can create more archived rooms when the pool is full',
        type: ApplicationCommandOptionType.Boolean,
        required: true,
      },
      {
        name: 'max-rooms',
        description: 'Maximum total managed rooms for this setup',
        type: ApplicationCommandOptionType.Integer,
        minValue: 1,
        maxValue: 99,
        required: false,
      },
    ],
  },
  {
    name: 'setup-remove',
    description: 'Remove an automatic voice room setup',
    type: ApplicationCommandType.ChatInput,
    dm_permission: false,
  },
];

if (legacyConfig) {
  console.log(`Loaded optional legacy config from ${configPath}.`);
} else {
  console.log('No config.json found. Use /setup in Discord to configure voice room pools.');
}

function createEmptyState() {
  return { activeChannels: {}, guilds: {} };
}

function ensureStateShape() {
  if (!botState.activeChannels || typeof botState.activeChannels !== 'object') {
    botState.activeChannels = {};
  }

  if (!botState.guilds || typeof botState.guilds !== 'object') {
    botState.guilds = {};
  }
}

function loadState() {
  if (!fs.existsSync(statePath)) {
    return createEmptyState();
  }

  try {
    const parsedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (!parsedState || typeof parsedState !== 'object') {
      console.warn('state.json is not in the expected format. Starting with empty bot state.');
      return createEmptyState();
    }
    return parsedState;
  } catch (error) {
    console.warn('Could not read state.json. Starting with empty bot state:', error);
    return createEmptyState();
  }
}

function saveState() {
  ensureStateShape();

  try {
    fs.writeFileSync(statePath, `${JSON.stringify(botState, null, 2)}\n`);
  } catch (error) {
    console.warn('Could not save state.json:', error);
  }
}

function loadLegacyConfig() {
  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!parsedConfig || typeof parsedConfig !== 'object') {
      return null;
    }

    return parsedConfig;
  } catch (error) {
    console.warn('Could not read config.json. The bot will rely on saved Discord setup instead:', error);
    return null;
  }
}

function isDiscordId(value) {
  return typeof value === 'string' && /^\d{5,}$/.test(value);
}

function normalizeModeratorHistoryDetail(detail) {
  if (!detail || typeof detail !== 'object') {
    return null;
  }

  const name = String(detail.name || '').trim();
  const value = String(detail.value || '').trim();
  if (!name || !value) {
    return null;
  }

  return {
    name: name.slice(0, 100),
    value: value.slice(0, 1000),
  };
}

function normalizeModeratorRoomHistoryEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const createdAt = typeof entry.createdAt === 'string' && !Number.isNaN(Date.parse(entry.createdAt))
    ? entry.createdAt
    : null;
  if (!createdAt) {
    return null;
  }

  const action = String(entry.action || '').trim();
  if (!action) {
    return null;
  }

  const details = Array.isArray(entry.details)
    ? entry.details.map(normalizeModeratorHistoryDetail).filter(Boolean).slice(0, 8)
    : [];

  return {
    id: String(entry.id || `${Date.parse(createdAt)}-${Math.random().toString(36).slice(2, 8)}`),
    type: entry.type === 'note' ? 'note' : 'action',
    action: action.slice(0, 120),
    createdAt,
    moderatorId: isDiscordId(entry.moderatorId) ? entry.moderatorId : null,
    moderatorTag: typeof entry.moderatorTag === 'string' ? entry.moderatorTag.slice(0, 120) : null,
    roomId: isDiscordId(entry.roomId) ? entry.roomId : null,
    roomName: typeof entry.roomName === 'string' ? entry.roomName.slice(0, 100) : null,
    details,
  };
}

function ensureGuildState(guildId) {
  ensureStateShape();

  if (!botState.guilds[guildId] || typeof botState.guilds[guildId] !== 'object') {
    botState.guilds[guildId] = {};
  }

  const guildState = botState.guilds[guildId];

  if (!Array.isArray(guildState.categories)) {
    guildState.categories = [];
  }

  if (!guildState.voiceLogs || typeof guildState.voiceLogs !== 'object') {
    const legacyChannelId = isDiscordId(guildState.voiceLogChannelId) ? guildState.voiceLogChannelId : null;
    guildState.voiceLogs = {
      channelId: legacyChannelId,
      enabled: Boolean(guildState.voiceLogsEnabled && legacyChannelId),
      updatedBy: null,
      updatedAt: null,
    };
  }

  if (!isDiscordId(guildState.voiceLogs.channelId)) {
    guildState.voiceLogs.channelId = null;
  }

  guildState.voiceLogs.enabled = Boolean(guildState.voiceLogs.enabled && guildState.voiceLogs.channelId);

  if (!isDiscordId(guildState.commandAccessRoleId)) {
    guildState.commandAccessRoleId = null;
  }

  if (!isDiscordId(guildState.commandAccessRoleUpdatedBy)) {
    guildState.commandAccessRoleUpdatedBy = null;
  }

  guildState.commandAccessRoleUpdatedAt = typeof guildState.commandAccessRoleUpdatedAt === 'string'
    ? guildState.commandAccessRoleUpdatedAt
    : null;

  if (!Array.isArray(guildState.moderatorRoomHistory)) {
    guildState.moderatorRoomHistory = [];
  }

  guildState.moderatorRoomHistory = guildState.moderatorRoomHistory
    .map(normalizeModeratorRoomHistoryEntry)
    .filter(Boolean)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, moderatorRoomHistoryLimit);

  if (!guildState.hostStats || typeof guildState.hostStats !== 'object' || Array.isArray(guildState.hostStats)) {
    guildState.hostStats = {};
  }

  for (const [userId, stats] of Object.entries(guildState.hostStats)) {
    if (!isDiscordId(userId) || !stats || typeof stats !== 'object' || Array.isArray(stats)) {
      delete guildState.hostStats[userId];
      continue;
    }

    const roomsHosted = Number(stats.roomsHosted);
    const totalHostedMs = Number(stats.totalHostedMs);
    stats.roomsHosted = Number.isFinite(roomsHosted) && roomsHosted > 0 ? Math.floor(roomsHosted) : 0;
    stats.totalHostedMs = Number.isFinite(totalHostedMs) && totalHostedMs > 0 ? Math.floor(totalHostedMs) : 0;

    const xp = Number(stats.xp);
    stats.xp = Number.isFinite(xp) && xp > 0
      ? Math.floor(xp)
      : calculateHostXp(stats.roomsHosted, stats.totalHostedMs);

    const currentStreakDays = Number(stats.currentStreakDays);
    const bestStreakDays = Number(stats.bestStreakDays);
    stats.currentStreakDays = Number.isFinite(currentStreakDays) && currentStreakDays > 0 ? Math.floor(currentStreakDays) : 0;
    stats.bestStreakDays = Number.isFinite(bestStreakDays) && bestStreakDays > 0
      ? Math.floor(bestStreakDays)
      : stats.currentStreakDays;
    stats.lastHostedDate = isDateKey(stats.lastHostedDate)
      ? stats.lastHostedDate
      : dateKeyFromValue(stats.lastHostedAt);
    if (stats.lastHostedDate && stats.currentStreakDays === 0) {
      stats.currentStreakDays = 1;
      stats.bestStreakDays = Math.max(stats.bestStreakDays, 1);
    }

    stats.lastHostedAt = typeof stats.lastHostedAt === 'string' ? stats.lastHostedAt : null;
    stats.lastRoomName = typeof stats.lastRoomName === 'string' ? stats.lastRoomName : null;
    stats.updatedAt = typeof stats.updatedAt === 'string' ? stats.updatedAt : null;
  }

  if (!guildState.memberStats || typeof guildState.memberStats !== 'object' || Array.isArray(guildState.memberStats)) {
    guildState.memberStats = {};
  }

  for (const [userId, stats] of Object.entries(guildState.memberStats)) {
    if (!isDiscordId(userId) || !stats || typeof stats !== 'object' || Array.isArray(stats)) {
      delete guildState.memberStats[userId];
      continue;
    }

    const voiceSessions = Number(stats.voiceSessions);
    const totalVoiceMs = Number(stats.totalVoiceMs);
    stats.voiceSessions = Number.isFinite(voiceSessions) && voiceSessions > 0 ? Math.floor(voiceSessions) : 0;
    stats.totalVoiceMs = Number.isFinite(totalVoiceMs) && totalVoiceMs > 0 ? Math.floor(totalVoiceMs) : 0;

    const xp = Number(stats.xp);
    stats.xp = Number.isFinite(xp) && xp > 0
      ? Math.floor(xp)
      : calculateMemberXp(stats.totalVoiceMs);

    const currentStreakDays = Number(stats.currentStreakDays);
    const bestStreakDays = Number(stats.bestStreakDays);
    stats.currentStreakDays = Number.isFinite(currentStreakDays) && currentStreakDays > 0 ? Math.floor(currentStreakDays) : 0;
    stats.bestStreakDays = Number.isFinite(bestStreakDays) && bestStreakDays > 0
      ? Math.floor(bestStreakDays)
      : stats.currentStreakDays;
    stats.lastVoiceDate = isDateKey(stats.lastVoiceDate)
      ? stats.lastVoiceDate
      : dateKeyFromValue(stats.lastVoiceAt);
    if (stats.lastVoiceDate && stats.currentStreakDays === 0) {
      stats.currentStreakDays = 1;
      stats.bestStreakDays = Math.max(stats.bestStreakDays, 1);
    }

    stats.lastVoiceAt = typeof stats.lastVoiceAt === 'string' ? stats.lastVoiceAt : null;
    stats.lastRoomName = typeof stats.lastRoomName === 'string' ? stats.lastRoomName : null;
    stats.updatedAt = typeof stats.updatedAt === 'string' ? stats.updatedAt : null;
  }

  return guildState;
}

function normalizeConfiguredCategory(guildId, category) {
  if (!category || typeof category !== 'object') {
    return null;
  }

  const requestChannelId = category.requestChannelId;
  const activeCategoryId = category.activeCategoryId;
  const archiveCategoryId = category.archiveCategoryId;

  if (!isDiscordId(requestChannelId) || !isDiscordId(activeCategoryId) || !isDiscordId(archiveCategoryId)) {
    return null;
  }

  return {
    guildId,
    name: category.name || 'Voice setup',
    requestChannelId,
    activeCategoryId,
    archiveCategoryId,
    autoCreateArchiveRooms: Boolean(category.autoCreateArchiveRooms),
    maxArchiveRooms: Number.isInteger(category.maxArchiveRooms) && category.maxArchiveRooms > 0 ? category.maxArchiveRooms : 10,
    createdBy: category.createdBy || null,
    createdAt: category.createdAt || null,
    updatedAt: category.updatedAt || null,
  };
}

function getConfiguredCategories(guildId) {
  const guildState = ensureGuildState(guildId);
  return guildState.categories
    .map((category) => normalizeConfiguredCategory(guildId, category))
    .filter(Boolean);
}

function saveConfiguredCategory(guildId, setup) {
  const guildState = ensureGuildState(guildId);
  const now = new Date().toISOString();
  const existingSetup = guildState.categories.find(
    (category) => category.requestChannelId === setup.requestChannelId
  );
  const normalizedSetup = {
    name: setup.name || 'Voice setup',
    requestChannelId: setup.requestChannelId,
    activeCategoryId: setup.activeCategoryId,
    archiveCategoryId: setup.archiveCategoryId,
    autoCreateArchiveRooms: setup.autoCreateArchiveRooms ?? existingSetup?.autoCreateArchiveRooms ?? false,
    maxArchiveRooms: setup.maxArchiveRooms ?? existingSetup?.maxArchiveRooms ?? 10,
    createdBy: setup.createdBy || null,
    createdAt: setup.createdAt || now,
    updatedAt: now,
  };

  const existingIndex = guildState.categories.findIndex(
    (category) => category.requestChannelId === normalizedSetup.requestChannelId
  );

  if (existingIndex >= 0) {
    guildState.categories[existingIndex] = {
      ...guildState.categories[existingIndex],
      ...normalizedSetup,
      createdAt: guildState.categories[existingIndex].createdAt || normalizedSetup.createdAt,
    };
  } else {
    guildState.categories.push(normalizedSetup);
  }

  saveState();
  return normalizeConfiguredCategory(guildId, normalizedSetup);
}

function removeConfiguredCategory(guildId, requestChannelId) {
  const guildState = ensureGuildState(guildId);
  const category = getConfiguredCategories(guildId).find((setup) => setup.requestChannelId === requestChannelId);
  if (!category) {
    return null;
  }

  guildState.categories = guildState.categories.filter((setup) => setup.requestChannelId !== requestChannelId);
  saveState();
  return category;
}

function updateAutoCreateSettings(guildId, requestChannelId, enabled, maxArchiveRooms = null) {
  const guildState = ensureGuildState(guildId);
  const category = guildState.categories.find((setup) => setup.requestChannelId === requestChannelId);
  if (!category) {
    return null;
  }

  category.autoCreateArchiveRooms = enabled;
  if (Number.isInteger(maxArchiveRooms) && maxArchiveRooms > 0) {
    category.maxArchiveRooms = maxArchiveRooms;
  } else if (!Number.isInteger(category.maxArchiveRooms) || category.maxArchiveRooms <= 0) {
    category.maxArchiveRooms = 10;
  }
  category.updatedAt = new Date().toISOString();
  saveState();

  return normalizeConfiguredCategory(guildId, category);
}

function getVoiceLogSettings(guildId) {
  const guildState = ensureGuildState(guildId);
  return {
    channelId: guildState.voiceLogs.channelId,
    enabled: Boolean(guildState.voiceLogs.enabled && guildState.voiceLogs.channelId),
    updatedBy: guildState.voiceLogs.updatedBy || null,
    updatedAt: guildState.voiceLogs.updatedAt || null,
  };
}

function saveVoiceLogSettings(guildId, settings) {
  const guildState = ensureGuildState(guildId);
  guildState.voiceLogs = {
    channelId: isDiscordId(settings.channelId) ? settings.channelId : null,
    enabled: Boolean(settings.enabled && isDiscordId(settings.channelId)),
    updatedBy: settings.updatedBy || null,
    updatedAt: new Date().toISOString(),
  };
  saveState();
  return getVoiceLogSettings(guildId);
}

function getCommandAccessRoleId(guildId) {
  const guildState = ensureGuildState(guildId);
  return isDiscordId(guildState.commandAccessRoleId) ? guildState.commandAccessRoleId : null;
}

function saveCommandAccessRole(guildId, roleId, updatedBy) {
  const guildState = ensureGuildState(guildId);
  guildState.commandAccessRoleId = isDiscordId(roleId) ? roleId : null;
  guildState.commandAccessRoleUpdatedBy = isDiscordId(updatedBy) ? updatedBy : null;
  guildState.commandAccessRoleUpdatedAt = new Date().toISOString();
  saveState();
  return getCommandAccessRoleId(guildId);
}

function createModeratorRoomHistoryId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function recordModeratorRoomHistory(guildId, entry) {
  if (!isDiscordId(guildId)) {
    return null;
  }

  const guildState = ensureGuildState(guildId);
  const normalizedEntry = normalizeModeratorRoomHistoryEntry({
    ...entry,
    id: entry.id || createModeratorRoomHistoryId(),
    createdAt: entry.createdAt || new Date().toISOString(),
  });

  if (!normalizedEntry) {
    return null;
  }

  guildState.moderatorRoomHistory.unshift(normalizedEntry);
  guildState.moderatorRoomHistory = guildState.moderatorRoomHistory.slice(0, moderatorRoomHistoryLimit);
  saveState();
  return normalizedEntry;
}

function recordModeratorAuditHistory(guild, auditEntry) {
  if (!guild || !auditEntry?.moderator || !auditEntry?.action) {
    return null;
  }

  return recordModeratorRoomHistory(guild.id, {
    type: auditEntry.type === 'note' ? 'note' : 'action',
    action: auditEntry.action,
    moderatorId: auditEntry.moderator.id,
    moderatorTag: auditEntry.moderator.user?.tag || auditEntry.moderator.displayName || auditEntry.moderator.id,
    roomId: auditEntry.voiceChannel?.id || null,
    roomName: auditEntry.voiceChannel?.name || null,
    details: auditEntry.details || [],
  });
}

function getModeratorRoomHistory(guildId, options = {}) {
  const guildState = ensureGuildState(guildId);
  const channelId = isDiscordId(options.channelId) ? options.channelId : null;
  const limit = Math.min(
    Math.max(Math.floor(Number(options.limit) || moderatorRoomHistoryDisplayLimit), 1),
    moderatorRoomHistoryDisplayLimit
  );

  return guildState.moderatorRoomHistory
    .filter((entry) => !channelId || entry.roomId === channelId)
    .slice(0, limit);
}

function toIsoDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function dateKeyFromValue(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function isDateKey(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`));
}

function dayNumberFromDateKey(dateKey) {
  if (!isDateKey(dateKey)) {
    return null;
  }

  return Math.floor(Date.parse(`${dateKey}T00:00:00.000Z`) / 86400000);
}

function calculateHostedMinuteXp(durationMs) {
  return Math.max(0, Math.floor(durationMs / 60000) * hostXpPerHostedMinute);
}

function calculateMemberMinuteXp(durationMs) {
  return Math.max(0, Math.floor(durationMs / 60000) * memberXpPerVoiceMinute);
}

function calculateHostXp(roomsHosted, totalHostedMs) {
  return (Math.max(0, Math.floor(Number(roomsHosted) || 0)) * hostRoomStartXp) + calculateHostedMinuteXp(Number(totalHostedMs) || 0);
}

function calculateMemberXp(totalVoiceMs) {
  return calculateMemberMinuteXp(Number(totalVoiceMs) || 0);
}

function getRankForXp(ranks, xp) {
  const normalizedXp = Math.max(0, Math.floor(Number(xp) || 0));
  let currentRank = ranks[0];
  let nextRank = null;
  let currentIndex = 0;

  for (let index = 0; index < ranks.length; index += 1) {
    const rank = ranks[index];
    if (normalizedXp >= rank.xp) {
      currentRank = rank;
      currentIndex = index;
      continue;
    }

    nextRank = rank;
    break;
  }

  return {
    currentRank,
    nextRank,
    currentLevel: currentIndex + 1,
    maxLevel: ranks.length,
  };
}

function getHostRank(xp) {
  return getRankForXp(hostRanks, xp);
}

function getMemberRank(xp) {
  return getRankForXp(memberRanks, xp);
}

function getRankProgress(ranks, xp) {
  const normalizedXp = Math.max(0, Math.floor(Number(xp) || 0));
  const { currentRank, nextRank, currentLevel, maxLevel } = getRankForXp(ranks, normalizedXp);
  const levelStartXp = Math.max(0, currentRank.xp || 0);

  if (!nextRank) {
    return {
      currentRank,
      nextRank,
      currentLevel,
      maxLevel,
      xp: normalizedXp,
      levelStartXp,
      nextLevelXp: levelStartXp,
      earnedXp: 1,
      neededXp: 1,
      percent: 1,
    };
  }

  const nextLevelXp = Math.max(levelStartXp + 1, nextRank.xp);
  const neededXp = Math.max(1, nextLevelXp - levelStartXp);
  const earnedXp = Math.min(Math.max(0, normalizedXp - levelStartXp), neededXp);

  return {
    currentRank,
    nextRank,
    currentLevel,
    maxLevel,
    xp: normalizedXp,
    levelStartXp,
    nextLevelXp,
    earnedXp,
    neededXp,
    percent: earnedXp / neededXp,
  };
}

function formatRankProgress(ranks, xp) {
  const progress = getRankProgress(ranks, xp);
  const title = `Level ${progress.currentLevel}/${progress.maxLevel}: ${progress.currentRank.name} - ${progress.xp} XP`;

  if (!progress.nextRank) {
    return `${title}\nMax level`;
  }

  return `${title}\n${progress.earnedXp}/${progress.neededXp} XP to ${progress.nextRank.name}`;
}

function formatHostRankProgress(xp) {
  return formatRankProgress(hostRanks, xp);
}

function formatMemberRankProgress(xp) {
  return formatRankProgress(memberRanks, xp);
}

function getHostRankProgress(xp) {
  return getRankProgress(hostRanks, xp);
}

function getMemberRankProgress(xp) {
  return getRankProgress(memberRanks, xp);
}

function getXpRankTrackRanks(track) {
  if (track === 'host') {
    return hostRanks;
  }

  if (track === 'member') {
    return memberRanks;
  }

  return null;
}

function getXpRankTrackLabel(track) {
  return track === 'host' ? 'Host' : 'Voice Member';
}

function getXpRankNames(track) {
  const ranks = getXpRankTrackRanks(track);
  return ranks ? ranks.map((rank) => rank.name) : [];
}

function getXpRankNameForMember(member, track) {
  if (!member?.guild) {
    return null;
  }

  if (track === 'host') {
    return getHostStatsSnapshot(member.guild, member.id).rank.currentRank.name;
  }

  if (track === 'member') {
    return getMemberStatsSnapshot(member.guild, member.id).rank.currentRank.name;
  }

  return null;
}

function hasTrackedXpStats(guildId, userId, track) {
  const guildState = ensureGuildState(guildId);
  if (track === 'host') {
    return Object.prototype.hasOwnProperty.call(guildState.hostStats || {}, userId);
  }

  if (track === 'member') {
    return Object.prototype.hasOwnProperty.call(guildState.memberStats || {}, userId);
  }

  return false;
}

function findGuildRoleByName(guild, roleName) {
  if (!guild?.roles?.cache || !roleName) {
    return null;
  }

  return guild.roles.cache.find((role) => role.name === roleName) ||
    guild.roles.cache.find((role) => role.name.toLowerCase() === roleName.toLowerCase()) ||
    null;
}

function memberHasDiscordRole(member, roleId) {
  return Boolean(member?.roles?.cache?.has(roleId));
}

function getBotRoleManagementIssue(guild, role) {
  const botMember = guild?.members?.me;
  if (!botMember) {
    return 'I could not check my server member profile.';
  }

  if (!botMember.permissions?.has(PermissionFlagsBits.ManageRoles)) {
    return 'I need Manage Roles.';
  }

  if (role.managed) {
    return `${role.name} is managed by an integration.`;
  }

  const highestRole = botMember.roles?.highest;
  if (highestRole && typeof highestRole.comparePositionTo === 'function' && highestRole.comparePositionTo(role) <= 0) {
    return `${role.name} is higher than or equal to my highest role.`;
  }

  return null;
}

async function fetchGuildMember(guild, userId) {
  if (!guild || !isDiscordId(userId)) {
    return null;
  }

  return guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
}

async function syncXpRankRoleForTrack(member, track) {
  const rankNames = getXpRankNames(track);
  const rankName = getXpRankNameForMember(member, track);
  if (!member || member.user?.bot || !rankName || rankNames.length === 0) {
    return { track, status: 'skipped' };
  }

  const currentRole = findGuildRoleByName(member.guild, rankName);
  if (!currentRole) {
    return { track, status: 'missing-role', rankName };
  }

  const currentRoleIssue = getBotRoleManagementIssue(member.guild, currentRole);
  if (currentRoleIssue) {
    return { track, status: 'blocked', rankName, issue: currentRoleIssue };
  }

  const obsoleteRoles = rankNames
    .filter((name) => name.toLowerCase() !== rankName.toLowerCase())
    .map((name) => findGuildRoleByName(member.guild, name))
    .filter((role) => role && memberHasDiscordRole(member, role.id));

  const removableRoles = [];
  const blockedRoles = [];
  for (const role of obsoleteRoles) {
    const issue = getBotRoleManagementIssue(member.guild, role);
    if (issue) {
      blockedRoles.push(`${role.name}: ${issue}`);
    } else {
      removableRoles.push(role);
    }
  }

  if (removableRoles.length > 0) {
    await member.roles.remove(removableRoles, `Voice XP rank changed to ${rankName}`);
  }

  const assigned = !memberHasDiscordRole(member, currentRole.id);
  if (assigned) {
    await member.roles.add(currentRole, `Voice XP rank reward: ${rankName}`);
  }

  return {
    track,
    status: blockedRoles.length > 0 ? 'partial' : 'synced',
    rankName,
    assigned,
    removed: removableRoles.length,
    blockedRoles,
  };
}

async function syncXpRankRolesForMember(member, tracks = ['host', 'member']) {
  const results = [];
  for (const track of tracks) {
    if (!hasTrackedXpStats(member.guild.id, member.id, track)) {
      results.push({ track, status: 'no-stats' });
      continue;
    }

    results.push(await syncXpRankRoleForTrack(member, track));
  }

  return results;
}

async function syncKnownXpRankRoles(guild, member = null) {
  const guildState = ensureGuildState(guild.id);
  const userIds = member
    ? [member.id]
    : [...new Set([
      ...Object.keys(guildState.hostStats || {}),
      ...Object.keys(guildState.memberStats || {}),
    ])];

  const summary = {
    memberCount: 0,
    trackCount: 0,
    assigned: 0,
    removed: 0,
    missingRoles: new Set(),
    blockedRoles: new Set(),
    noStats: 0,
    missingMembers: 0,
  };

  for (const userId of userIds) {
    const guildMember = member?.id === userId ? member : await fetchGuildMember(guild, userId);
    if (!guildMember) {
      summary.missingMembers += 1;
      continue;
    }

    summary.memberCount += 1;
    const results = await syncXpRankRolesForMember(guildMember);
    for (const result of results) {
      if (result.status === 'no-stats') {
        summary.noStats += 1;
        continue;
      }

      summary.trackCount += 1;
      if (result.status === 'missing-role') {
        summary.missingRoles.add(result.rankName);
      }

      if (result.status === 'blocked') {
        summary.blockedRoles.add(`${result.rankName}: ${result.issue}`);
      }

      for (const blockedRole of result.blockedRoles || []) {
        summary.blockedRoles.add(blockedRole);
      }

      summary.assigned += result.assigned ? 1 : 0;
      summary.removed += result.removed || 0;
    }
  }

  return summary;
}

function queueXpRankRoleSync(guildId, userId, track) {
  if (!isDiscordId(guildId) || !isDiscordId(userId) || !getXpRankTrackRanks(track)) {
    return;
  }

  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    return;
  }

  fetchGuildMember(guild, userId)
    .then((member) => {
      if (!member) {
        return null;
      }

      return syncXpRankRoleForTrack(member, track);
    })
    .catch((error) => {
      console.warn(`Could not sync ${getXpRankTrackLabel(track)} XP rank role for ${userId}:`, error);
    });
}

function updateDailyStreak(stats, dateField, activityAt = new Date()) {
  if (!stats) {
    return;
  }

  const activityDateKey = dateKeyFromValue(activityAt);
  if (!activityDateKey || stats[dateField] === activityDateKey) {
    return;
  }

  const previousDay = dayNumberFromDateKey(stats[dateField]);
  const currentDay = dayNumberFromDateKey(activityDateKey);
  const continuedStreak = previousDay !== null && currentDay === previousDay + 1;
  stats.currentStreakDays = continuedStreak ? Math.max(0, Number(stats.currentStreakDays) || 0) + 1 : 1;
  stats.bestStreakDays = Math.max(Number(stats.bestStreakDays) || 0, stats.currentStreakDays);
  stats[dateField] = activityDateKey;
}

function updateHostStreak(stats, hostedAt = new Date()) {
  updateDailyStreak(stats, 'lastHostedDate', hostedAt);
}

function updateMemberStreak(stats, voiceAt = new Date()) {
  updateDailyStreak(stats, 'lastVoiceDate', voiceAt);
}

function getVisibleCurrentStreakDays(stats, now = new Date(), dateField = 'lastHostedDate') {
  if (!stats?.[dateField]) {
    return 0;
  }

  const lastDay = dayNumberFromDateKey(stats[dateField]);
  const currentDay = dayNumberFromDateKey(dateKeyFromValue(now));
  if (lastDay === null || currentDay === null || currentDay - lastDay > 1) {
    return 0;
  }

  return Math.max(0, Math.floor(Number(stats.currentStreakDays) || 0));
}

function getHostStatsEntry(guildId, userId) {
  if (!isDiscordId(guildId) || !isDiscordId(userId)) {
    return null;
  }

  const guildState = ensureGuildState(guildId);
  if (!guildState.hostStats[userId] || typeof guildState.hostStats[userId] !== 'object') {
    guildState.hostStats[userId] = {
      roomsHosted: 0,
      totalHostedMs: 0,
      xp: 0,
      currentStreakDays: 0,
      bestStreakDays: 0,
      lastHostedAt: null,
      lastHostedDate: null,
      lastRoomName: null,
      updatedAt: null,
    };
  }

  return guildState.hostStats[userId];
}

function getMemberStatsEntry(guildId, userId) {
  if (!isDiscordId(guildId) || !isDiscordId(userId)) {
    return null;
  }

  const guildState = ensureGuildState(guildId);
  if (!guildState.memberStats[userId] || typeof guildState.memberStats[userId] !== 'object') {
    guildState.memberStats[userId] = {
      voiceSessions: 0,
      totalVoiceMs: 0,
      xp: 0,
      currentStreakDays: 0,
      bestStreakDays: 0,
      lastVoiceAt: null,
      lastVoiceDate: null,
      lastRoomName: null,
      updatedAt: null,
    };
  }

  return guildState.memberStats[userId];
}

function recordHostSessionStart(guildId, userId, voiceChannel, startedAt = new Date()) {
  const stats = getHostStatsEntry(guildId, userId);
  if (!stats) {
    return;
  }

  const startedIso = toIsoDate(startedAt);
  stats.roomsHosted += 1;
  stats.xp = Math.max(0, Math.floor(Number(stats.xp) || 0)) + hostRoomStartXp;
  updateHostStreak(stats, startedAt);
  stats.lastHostedAt = startedIso;
  stats.lastRoomName = voiceChannel?.name || stats.lastRoomName || null;
  stats.updatedAt = startedIso;
  queueXpRankRoleSync(guildId, userId, 'host');
}

function closeHostSession(guildId, userId, startedAt, endedAt = new Date(), roomName = null) {
  const stats = getHostStatsEntry(guildId, userId);
  if (!stats || !startedAt) {
    return;
  }

  const startedMs = Date.parse(startedAt);
  const endedDate = endedAt instanceof Date ? endedAt : new Date(endedAt);
  const endedMs = endedDate.getTime();
  if (Number.isFinite(startedMs) && Number.isFinite(endedMs) && endedMs > startedMs) {
    const durationMs = endedMs - startedMs;
    stats.totalHostedMs += durationMs;
    stats.xp = Math.max(0, Math.floor(Number(stats.xp) || 0)) + calculateHostedMinuteXp(durationMs);
    updateHostStreak(stats, endedDate);
  }

  const endedIso = toIsoDate(endedDate);
  stats.lastHostedAt = endedIso;
  stats.lastRoomName = roomName || stats.lastRoomName || null;
  stats.updatedAt = endedIso;
  queueXpRankRoleSync(guildId, userId, 'host');
}

function normalizeActiveMemberSessions(memberSessions, ownerId = null) {
  if (!memberSessions || typeof memberSessions !== 'object' || Array.isArray(memberSessions)) {
    return {};
  }

  return Object.entries(memberSessions).reduce((sessions, [userId, startedAt]) => {
    const startedAtIso = typeof startedAt === 'string' ? startedAt : null;
    if (isDiscordId(userId) && startedAtIso && !Number.isNaN(Date.parse(startedAtIso))) {
      sessions[userId] = startedAtIso;
    }
    return sessions;
  }, {});
}

function getRoomNameForSavedChannel(savedChannel, fallbackName = null) {
  return savedChannel?.channelName || savedChannel?.originalChannelName || fallbackName || null;
}

function recordMemberSessionStart(guildId, userId, voiceChannel, startedAt = new Date()) {
  const stats = getMemberStatsEntry(guildId, userId);
  if (!stats) {
    return;
  }

  const startedIso = toIsoDate(startedAt);
  stats.voiceSessions += 1;
  updateMemberStreak(stats, startedAt);
  stats.lastVoiceAt = startedIso;
  stats.lastRoomName = voiceChannel?.name || stats.lastRoomName || null;
  stats.updatedAt = startedIso;
}

function closeMemberSession(guildId, userId, startedAt, endedAt = new Date(), roomName = null) {
  const stats = getMemberStatsEntry(guildId, userId);
  if (!stats || !startedAt) {
    return;
  }

  const startedMs = Date.parse(startedAt);
  const endedDate = endedAt instanceof Date ? endedAt : new Date(endedAt);
  const endedMs = endedDate.getTime();
  if (Number.isFinite(startedMs) && Number.isFinite(endedMs) && endedMs > startedMs) {
    const durationMs = endedMs - startedMs;
    stats.totalVoiceMs += durationMs;
    stats.xp = Math.max(0, Math.floor(Number(stats.xp) || 0)) + calculateMemberMinuteXp(durationMs);
    updateMemberStreak(stats, endedDate);
  }

  const endedIso = toIsoDate(endedDate);
  stats.lastVoiceAt = endedIso;
  stats.lastRoomName = roomName || stats.lastRoomName || null;
  stats.updatedAt = endedIso;
  queueXpRankRoleSync(guildId, userId, 'member');
}

function closeSavedMemberSession(savedChannel, userId, endedAt = new Date(), roomName = null) {
  if (!savedChannel || !isDiscordId(userId)) {
    return false;
  }

  const memberSessions = normalizeActiveMemberSessions(savedChannel.memberSessions, savedChannel.ownerId);
  const startedAt = memberSessions[userId];
  savedChannel.memberSessions = memberSessions;
  if (!startedAt) {
    return false;
  }

  closeMemberSession(
    savedChannel.guildId,
    userId,
    startedAt,
    endedAt,
    roomName || getRoomNameForSavedChannel(savedChannel)
  );
  delete memberSessions[userId];
  savedChannel.updatedAt = toIsoDate(endedAt);
  return true;
}

function closeSavedMemberSessions(savedChannel, endedAt = new Date()) {
  if (!savedChannel) {
    return;
  }

  const memberSessions = normalizeActiveMemberSessions(savedChannel.memberSessions, savedChannel.ownerId);
  for (const [userId, startedAt] of Object.entries(memberSessions)) {
    closeMemberSession(
      savedChannel.guildId,
      userId,
      startedAt,
      endedAt,
      getRoomNameForSavedChannel(savedChannel)
    );
  }

  savedChannel.memberSessions = {};
  savedChannel.updatedAt = toIsoDate(endedAt);
}

function syncMemberSessionsForVoiceChannel(voiceChannel, guildId, ownerId, memberSessions = {}, syncedAt = new Date()) {
  const sessions = normalizeActiveMemberSessions(memberSessions, ownerId);
  if (!voiceChannel?.members || !isDiscordId(guildId)) {
    return sessions;
  }

  const activeMemberIds = new Set();
  for (const member of voiceChannel.members.values()) {
    if (!member.user.bot) {
      activeMemberIds.add(member.id);
    }
  }

  for (const [userId, startedAt] of Object.entries(sessions)) {
    if (userId === ownerId || !activeMemberIds.has(userId)) {
      closeMemberSession(guildId, userId, startedAt, syncedAt, voiceChannel.name);
      delete sessions[userId];
    }
  }

  const syncedIso = toIsoDate(syncedAt);
  for (const userId of activeMemberIds) {
    if (userId === ownerId || sessions[userId]) {
      continue;
    }

    const member = voiceChannel.members.get(userId);
    if (!member || member.user.bot) {
      continue;
    }

    sessions[userId] = syncedIso;
    recordMemberSessionStart(guildId, userId, voiceChannel, syncedAt);
  }

  return sessions;
}

function recordRegularMemberSessionStartForChannel(voiceChannel, member, startedAt = new Date(), shouldSave = true) {
  if (!voiceChannel || !member || member.user?.bot) {
    return false;
  }

  const savedChannel = botState.activeChannels[voiceChannel.id];
  if (!savedChannel || savedChannel.guildId !== voiceChannel.guild?.id || member.id === savedChannel.ownerId) {
    return false;
  }

  savedChannel.memberSessions = normalizeActiveMemberSessions(savedChannel.memberSessions, savedChannel.ownerId);
  if (savedChannel.memberSessions[member.id]) {
    return false;
  }

  savedChannel.memberSessions[member.id] = toIsoDate(startedAt);
  savedChannel.updatedAt = toIsoDate(startedAt);
  recordMemberSessionStart(savedChannel.guildId, member.id, voiceChannel, startedAt);

  if (shouldSave) {
    saveState();
  }
  return true;
}

function closeRegularMemberSessionForChannel(voiceChannel, userId, endedAt = new Date(), shouldSave = true) {
  if (!voiceChannel || !isDiscordId(userId)) {
    return false;
  }

  const savedChannel = botState.activeChannels[voiceChannel.id];
  const closed = closeSavedMemberSession(savedChannel, userId, endedAt, voiceChannel.name);
  if (closed && shouldSave) {
    saveState();
  }
  return closed;
}

function getActiveHostedMs(guildId, userId, nowMs = Date.now()) {
  return Object.values(botState.activeChannels || {}).reduce((total, savedChannel) => {
    if (savedChannel.guildId !== guildId || savedChannel.ownerId !== userId || !savedChannel.ownerSessionStartedAt) {
      return total;
    }

    const startedMs = Date.parse(savedChannel.ownerSessionStartedAt);
    if (!Number.isFinite(startedMs) || nowMs <= startedMs) {
      return total;
    }

    return total + (nowMs - startedMs);
  }, 0);
}

function getActiveHostedRoomCount(guildId, userId) {
  return Object.values(botState.activeChannels || {}).filter(
    (savedChannel) => savedChannel.guildId === guildId && savedChannel.ownerId === userId
  ).length;
}

function getActiveHostedXp(guildId, userId, nowMs = Date.now()) {
  return calculateHostedMinuteXp(getActiveHostedMs(guildId, userId, nowMs));
}

function getActiveMemberVoiceMs(guildId, userId, nowMs = Date.now()) {
  return Object.values(botState.activeChannels || {}).reduce((total, savedChannel) => {
    if (savedChannel.guildId !== guildId || savedChannel.ownerId === userId) {
      return total;
    }

    const memberSessions = normalizeActiveMemberSessions(savedChannel.memberSessions, savedChannel.ownerId);
    const startedAt = memberSessions[userId];
    if (!startedAt) {
      return total;
    }

    const startedMs = Date.parse(startedAt);
    if (!Number.isFinite(startedMs) || nowMs <= startedMs) {
      return total;
    }

    return total + (nowMs - startedMs);
  }, 0);
}

function getActiveMemberVoiceRoomCount(guildId, userId) {
  return Object.values(botState.activeChannels || {}).filter((savedChannel) => {
    if (savedChannel.guildId !== guildId || savedChannel.ownerId === userId) {
      return false;
    }

    const memberSessions = normalizeActiveMemberSessions(savedChannel.memberSessions, savedChannel.ownerId);
    return Boolean(memberSessions[userId]);
  }).length;
}

function getActiveMemberVoiceXp(guildId, userId, nowMs = Date.now()) {
  return calculateMemberMinuteXp(getActiveMemberVoiceMs(guildId, userId, nowMs));
}

function getHostStatsSnapshot(guild, userId, nowMs = Date.now()) {
  const guildState = ensureGuildState(guild.id);
  const stats = guildState.hostStats?.[userId] || {};
  const roomsHosted = Math.max(0, Math.floor(Number(stats.roomsHosted) || 0));
  const activeRooms = getActiveHostedRoomCount(guild.id, userId);
  const totalHostedMs = Math.max(0, Math.floor(Number(stats.totalHostedMs) || 0)) + getActiveHostedMs(guild.id, userId, nowMs);
  const xp = Math.max(0, Math.floor(Number(stats.xp) || calculateHostXp(roomsHosted, stats.totalHostedMs || 0))) + getActiveHostedXp(guild.id, userId, nowMs);
  return {
    userId,
    roomsHosted,
    totalHostedMs,
    xp,
    rank: getHostRank(xp),
    activeRooms,
    currentStreakDays: getVisibleCurrentStreakDays(stats, new Date(nowMs)),
    bestStreakDays: Math.max(0, Math.floor(Number(stats.bestStreakDays) || 0)),
    lastHostedAt: stats.lastHostedAt || null,
    lastHostedDate: stats.lastHostedDate || null,
    lastRoomName: stats.lastRoomName || null,
  };
}

function getMemberStatsSnapshot(guild, userId, nowMs = Date.now()) {
  const guildState = ensureGuildState(guild.id);
  const stats = guildState.memberStats?.[userId] || {};
  const voiceSessions = Math.max(0, Math.floor(Number(stats.voiceSessions) || 0));
  const activeRooms = getActiveMemberVoiceRoomCount(guild.id, userId);
  const totalVoiceMs = Math.max(0, Math.floor(Number(stats.totalVoiceMs) || 0)) + getActiveMemberVoiceMs(guild.id, userId, nowMs);
  const xp = Math.max(0, Math.floor(Number(stats.xp) || calculateMemberXp(stats.totalVoiceMs || 0))) + getActiveMemberVoiceXp(guild.id, userId, nowMs);
  return {
    userId,
    voiceSessions,
    totalVoiceMs,
    xp,
    rank: getMemberRank(xp),
    activeRooms,
    currentStreakDays: getVisibleCurrentStreakDays(stats, new Date(nowMs), 'lastVoiceDate'),
    bestStreakDays: Math.max(0, Math.floor(Number(stats.bestStreakDays) || 0)),
    lastVoiceAt: stats.lastVoiceAt || null,
    lastVoiceDate: stats.lastVoiceDate || null,
    lastRoomName: stats.lastRoomName || null,
  };
}

function formatHostedDuration(totalMs) {
  const totalMinutes = Math.max(0, Math.floor(totalMs / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];

  if (days > 0) {
    parts.push(`${days}d`);
  }

  if (hours > 0 || days > 0) {
    parts.push(`${hours}h`);
  }

  parts.push(`${minutes}m`);
  return parts.join(' ');
}

function getTopHostRows(guild, limit = 10) {
  const guildState = ensureGuildState(guild.id);
  const nowMs = Date.now();

  return Object.keys(guildState.hostStats || {})
    .map((userId) => getHostStatsSnapshot(guild, userId, nowMs))
    .filter((row) => row.roomsHosted > 0 || row.totalHostedMs > 0 || row.activeRooms > 0 || row.xp > 0)
    .sort((a, b) =>
      b.xp - a.xp ||
      b.roomsHosted - a.roomsHosted ||
      b.totalHostedMs - a.totalHostedMs ||
      a.userId.localeCompare(b.userId)
    )
    .slice(0, limit);
}

async function buildTopHostsCard(guild, limit = 10) {
  const rows = getTopHostRows(guild, limit);
  const members = new Map();

  await Promise.all(rows.map(async (row) => {
    const member = guild.members.cache.get(row.userId) || await guild.members.fetch(row.userId).catch(() => null);
    members.set(row.userId, member);
  }));

  const fields = rows.map((row, index) => {
    const member = members.get(row.userId);
    const hostLabel = member?.user?.tag || member?.displayName || row.userId;
    const progress = getHostRankProgress(row.xp);
    const details = [
      formatHostRankProgress(row.xp),
      `${row.roomsHosted} hosted room(s)`,
      `${formatHostedDuration(row.totalHostedMs)} total hosted time`,
      `${row.currentStreakDays} day current streak - best ${row.bestStreakDays}`,
    ];

    if (row.activeRooms > 0) {
      details.push(`${row.activeRooms} active now`);
    }

    if (row.lastRoomName) {
      details.push(`Last room: ${row.lastRoomName}`);
    }

    return {
      name: `#${index + 1} ${hostLabel}`,
      value: truncateFieldValue(details.join('\n')),
      inline: false,
      progress,
    };
  });

  if (fields.length === 0) {
    fields.push({
      name: 'No host stats yet',
      value: 'Stats will appear after members start hosting managed voice rooms.',
      inline: false,
    });
  }

  return createCardAttachment({
    badge: 'TOP',
    title: 'Top Voice Room Hosts',
    description: fields.length > 1 ? `Showing the top ${fields.length} host(s) by XP.` : null,
    fields,
    footer: 'Server managers, the access role, and the bot owner can view this leaderboard. Active sessions are included in total time.',
  }, 'top-hosts');
}

async function buildHostProfileCard(guild, userId) {
  const member = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
  const row = getHostStatsSnapshot(guild, userId);
  const hostLabel = member?.user?.tag || member?.displayName || userId;
  const fields = [
    { name: 'Rank', value: formatHostRankProgress(row.xp), inline: false, progress: getHostRankProgress(row.xp) },
    { name: 'Rooms Hosted', value: `${row.roomsHosted}`, inline: true },
    { name: 'Hosted Time', value: formatHostedDuration(row.totalHostedMs), inline: true },
    { name: 'Streak', value: `${row.currentStreakDays} day current\nBest: ${row.bestStreakDays} day`, inline: true },
  ];

  if (row.activeRooms > 0) {
    fields.push({ name: 'Active Now', value: `${row.activeRooms} room(s)`, inline: true });
  }

  if (row.lastRoomName) {
    fields.push({ name: 'Last Room', value: row.lastRoomName, inline: false });
  }

  if (row.roomsHosted === 0 && row.xp === 0) {
    fields.push({ name: 'No XP yet', value: 'Host a managed voice room to start earning XP and streaks.', inline: false });
  }

  return createCardAttachment({
    badge: 'XP',
    title: 'Host Profile',
    subtitle: hostLabel,
    fields,
    footer: 'Earn 25 XP for opening a room, plus 1 XP per hosted minute.',
  }, 'host-profile');
}

function getTopMemberRows(guild, limit = 10) {
  const guildState = ensureGuildState(guild.id);
  const nowMs = Date.now();

  return Object.keys(guildState.memberStats || {})
    .map((userId) => getMemberStatsSnapshot(guild, userId, nowMs))
    .filter((row) => row.voiceSessions > 0 || row.totalVoiceMs > 0 || row.activeRooms > 0 || row.xp > 0)
    .sort((a, b) =>
      b.xp - a.xp ||
      b.totalVoiceMs - a.totalVoiceMs ||
      b.voiceSessions - a.voiceSessions ||
      a.userId.localeCompare(b.userId)
    )
    .slice(0, limit);
}

async function buildTopMembersCard(guild, limit = 10) {
  const rows = getTopMemberRows(guild, limit);
  const members = new Map();

  await Promise.all(rows.map(async (row) => {
    const member = guild.members.cache.get(row.userId) || await guild.members.fetch(row.userId).catch(() => null);
    members.set(row.userId, member);
  }));

  const fields = rows.map((row, index) => {
    const member = members.get(row.userId);
    const memberLabel = member?.user?.tag || member?.displayName || row.userId;
    const progress = getMemberRankProgress(row.xp);
    const details = [
      formatMemberRankProgress(row.xp),
      `${formatHostedDuration(row.totalVoiceMs)} regular voice time`,
      `${row.voiceSessions} room visit(s)`,
      `${row.currentStreakDays} day current streak - best ${row.bestStreakDays}`,
    ];

    if (row.activeRooms > 0) {
      details.push(`${row.activeRooms} active now`);
    }

    if (row.lastRoomName) {
      details.push(`Last room: ${row.lastRoomName}`);
    }

    return {
      name: `#${index + 1} ${memberLabel}`,
      value: truncateFieldValue(details.join('\n')),
      inline: false,
      progress,
    };
  });

  if (fields.length === 0) {
    fields.push({
      name: 'No member stats yet',
      value: 'Stats will appear after members spend time in managed voice rooms.',
      inline: false,
    });
  }

  return createCardAttachment({
    badge: 'TOP',
    title: 'Top Voice Room Members',
    description: fields.length > 1 ? `Showing the top ${fields.length} member(s) by regular voice XP.` : null,
    fields,
    footer: 'Regular members earn 1 XP per minute in managed voice rooms. Host XP is tracked separately.',
  }, 'top-members');
}

async function buildVoiceProfileCard(guild, userId) {
  const member = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
  const row = getMemberStatsSnapshot(guild, userId);
  const memberLabel = member?.user?.tag || member?.displayName || userId;
  const fields = [
    { name: 'Rank', value: formatMemberRankProgress(row.xp), inline: false, progress: getMemberRankProgress(row.xp) },
    { name: 'Voice Time', value: formatHostedDuration(row.totalVoiceMs), inline: true },
    { name: 'Room Visits', value: `${row.voiceSessions}`, inline: true },
    { name: 'Streak', value: `${row.currentStreakDays} day current\nBest: ${row.bestStreakDays} day`, inline: true },
  ];

  if (row.activeRooms > 0) {
    fields.push({ name: 'Active Now', value: `${row.activeRooms} room(s)`, inline: true });
  }

  if (row.lastRoomName) {
    fields.push({ name: 'Last Room', value: row.lastRoomName, inline: false });
  }

  if (row.voiceSessions === 0 && row.xp === 0) {
    fields.push({ name: 'No XP yet', value: 'Join a managed voice room as a regular member to start earning XP.', inline: false });
  }

  return createCardAttachment({
    badge: 'XP',
    title: 'Voice Member Profile',
    subtitle: memberLabel,
    fields,
    footer: 'Regular members earn 1 XP per minute. Hosting XP stays on /hostprofile.',
  }, 'voice-profile');
}

function migrateLegacyConfig(config) {
  if (!config || !isDiscordId(config.guildId) || !Array.isArray(config.categories)) {
    return;
  }

  let migrated = 0;
  for (const category of config.categories) {
    const normalizedCategory = normalizeConfiguredCategory(config.guildId, category);
    if (!normalizedCategory) {
      continue;
    }

    const existingCategory = getConfiguredCategories(config.guildId).find(
      (setup) => setup.requestChannelId === normalizedCategory.requestChannelId
    );

    if (
      existingCategory &&
      existingCategory.activeCategoryId === normalizedCategory.activeCategoryId &&
      existingCategory.archiveCategoryId === normalizedCategory.archiveCategoryId
    ) {
      continue;
    }

    saveConfiguredCategory(config.guildId, {
      ...normalizedCategory,
      createdAt: normalizedCategory.createdAt || new Date().toISOString(),
    });
    migrated += 1;
  }

  if (migrated > 0) {
    console.log(`Migrated ${migrated} setup entries from config.json into state.json.`);
  }
}

function findCategoryForSavedChannel(savedChannel, guildId = null) {
  const guildIds = guildId ? [guildId] : Object.keys(botState.guilds || {});

  for (const currentGuildId of guildIds) {
    const category = getConfiguredCategories(currentGuildId).find(
      (setup) =>
        setup.archiveCategoryId === savedChannel.archiveCategoryId ||
        setup.activeCategoryId === savedChannel.activeCategoryId ||
        setup.requestChannelId === savedChannel.requestChannelId
    );

    if (category) {
      return category;
    }
  }

  return null;
}

function serializePermissionSnapshot(snapshot) {
  if (!Array.isArray(snapshot)) {
    return [];
  }

  return snapshot
    .filter((overwrite) => overwrite?.id && overwrite.type !== undefined)
    .map((overwrite) => ({
      id: overwrite.id,
      type: overwrite.type,
      allow: typeof overwrite.allow === 'bigint' ? overwrite.allow.toString() : String(overwrite.allow || 0),
      deny: typeof overwrite.deny === 'bigint' ? overwrite.deny.toString() : String(overwrite.deny || 0),
    }));
}

function normalizePermissionSnapshot(snapshot) {
  if (!Array.isArray(snapshot)) {
    return [];
  }

  return snapshot
    .filter((overwrite) => overwrite?.id && overwrite.type !== undefined)
    .map((overwrite) => ({
      id: overwrite.id,
      type: overwrite.type,
      allow: BigInt(overwrite.allow || 0),
      deny: BigInt(overwrite.deny || 0),
    }));
}

function closeSavedHostSession(savedChannel, endedAt = new Date()) {
  if (!savedChannel) {
    return;
  }

  closeHostSession(
    savedChannel.guildId,
    savedChannel.ownerId,
    savedChannel.ownerSessionStartedAt,
    endedAt,
    savedChannel.channelName || savedChannel.originalChannelName || null
  );
}

function closeSavedActiveChannelSessions(savedChannel, endedAt = new Date()) {
  closeSavedHostSession(savedChannel, endedAt);
  closeSavedMemberSessions(savedChannel, endedAt);
}

function rememberActiveChannel(voiceChannel, ownerId, category = null, permissionSnapshot = null) {
  const existingState = botState.activeChannels[voiceChannel.id] || {};
  const poolEntry = poolChannelArchive.get(voiceChannel.id);
  const guildId = category?.guildId || existingState.guildId || voiceChannel.guild?.id || poolEntry?.guildId || null;
  const archiveCategoryId =
    category?.archiveCategoryId || existingState.archiveCategoryId || poolEntry?.archiveCategoryId || null;
  const savedPermissionSnapshot = serializePermissionSnapshot(permissionSnapshot || existingState.permissionOverwrites || []);
  const originalChannelName = existingState.originalChannelName || existingState.channelName || voiceChannel.name;
  const now = new Date();
  const nowIso = now.toISOString();
  const ownerChanged = existingState.ownerId !== ownerId;
  const memberSessions = syncMemberSessionsForVoiceChannel(voiceChannel, guildId, ownerId, existingState.memberSessions, now);

  if (existingState.ownerId && ownerChanged) {
    closeSavedHostSession(existingState, now);
  }

  const ownerSessionStartedAt = !ownerChanged && existingState.ownerSessionStartedAt
    ? existingState.ownerSessionStartedAt
    : nowIso;

  if (ownerChanged || !existingState.ownerSessionStartedAt) {
    recordHostSessionStart(guildId, ownerId, voiceChannel, now);
  }

  botState.activeChannels[voiceChannel.id] = {
    guildId,
    channelName: voiceChannel.name,
    originalChannelName,
    ownerId,
    ownerSessionStartedAt,
    categoryName: category?.name || existingState.categoryName || null,
    requestChannelId: category?.requestChannelId || existingState.requestChannelId || null,
    activeCategoryId: category?.activeCategoryId || existingState.activeCategoryId || voiceChannel.parentId || null,
    archiveCategoryId,
    permissionOverwrites: savedPermissionSnapshot,
    memberSessions,
    moderatorLocked: Boolean(existingState.moderatorLocked),
    moderatorLockedBy: existingState.moderatorLockedBy || null,
    moderatorLockedAt: existingState.moderatorLockedAt || null,
    moderatorLockPermissionOverwrites: existingState.moderatorLockPermissionOverwrites || null,
    updatedAt: nowIso,
  };

  voiceChannelOwners.set(voiceChannel.id, ownerId);
  if (archiveCategoryId) {
    poolChannelArchive.set(voiceChannel.id, { guildId, archiveCategoryId });
  }
  saveState();
}

function forgetActiveChannel(voiceChannelId) {
  closeSavedActiveChannelSessions(botState.activeChannels[voiceChannelId]);
  voiceChannelOwners.delete(voiceChannelId);
  voiceChannelPermissionSnapshots.delete(voiceChannelId);
  delete botState.activeChannels[voiceChannelId];
  saveState();
}

function clearGuildIndexes(guildId) {
  for (const [requestChannelId, category] of requestChannelById.entries()) {
    if (category.guildId === guildId) {
      requestChannelById.delete(requestChannelId);
    }
  }

  for (const [channelId, entry] of poolChannelArchive.entries()) {
    if (entry.guildId === guildId) {
      poolChannelArchive.delete(channelId);
    }
  }
}

async function rebuildGuildIndexes(guild) {
  await guild.channels.fetch();
  clearGuildIndexes(guild.id);

  const categories = getConfiguredCategories(guild.id);
  if (categories.length === 0) {
    console.log(`No voice room setups saved for ${guild.name}. Use /setup in that server.`);
    return;
  }

  let archiveChannelCount = 0;

  for (const category of categories) {
    const requestChannel = guild.channels.cache.get(category.requestChannelId);
    const archiveCategory = guild.channels.cache.get(category.archiveCategoryId);
    const activeCategory = guild.channels.cache.get(category.activeCategoryId);

    if (!requestChannel || requestChannel.type !== ChannelType.GuildVoice) {
      console.warn(`Request voice channel not found for setup "${category.name}" in ${guild.name}.`);
      continue;
    }

    if (!archiveCategory || archiveCategory.type !== ChannelType.GuildCategory) {
      console.warn(`Archive category not found for setup "${category.name}" in ${guild.name}.`);
      continue;
    }

    if (!activeCategory || activeCategory.type !== ChannelType.GuildCategory) {
      console.warn(`Active category not found for setup "${category.name}" in ${guild.name}.`);
      continue;
    }

    requestChannelById.set(category.requestChannelId, category);

    const archiveVoiceChannels = guild.channels.cache.filter(
      (channel) => channel.parentId === archiveCategory.id && channel.type === ChannelType.GuildVoice
    );

    for (const channel of archiveVoiceChannels.values()) {
      poolChannelArchive.set(channel.id, { guildId: guild.id, archiveCategoryId: category.archiveCategoryId });
      archiveChannelCount += 1;
    }
  }

  console.log(`Loaded ${archiveChannelCount} archive voice channels from ${categories.length} saved setup(s) in ${guild.name}.`);
  await restoreActiveChannels(guild);
}

async function restoreActiveChannels(guild) {
  const savedChannels = Object.entries(botState.activeChannels || {});
  if (savedChannels.length === 0) {
    return;
  }

  let changedState = false;

  for (const [channelId, savedChannel] of savedChannels) {
    if (savedChannel.guildId && savedChannel.guildId !== guild.id) {
      continue;
    }

    const voiceChannel = guild.channels.cache.get(channelId);
    if (!voiceChannel) {
      if (savedChannel.guildId === guild.id) {
        closeSavedActiveChannelSessions(savedChannel);
        voiceChannelOwners.delete(channelId);
        voiceChannelPermissionSnapshots.delete(channelId);
        delete botState.activeChannels[channelId];
        changedState = true;
      }
      continue;
    }

    const category = findCategoryForSavedChannel(savedChannel, guild.id);
    if (!category || voiceChannel.type !== ChannelType.GuildVoice) {
      closeSavedActiveChannelSessions(savedChannel);
      voiceChannelOwners.delete(channelId);
      voiceChannelPermissionSnapshots.delete(channelId);
      delete botState.activeChannels[channelId];
      changedState = true;
      continue;
    }

    poolChannelArchive.set(channelId, { guildId: guild.id, archiveCategoryId: category.archiveCategoryId });

    if (savedChannel.permissionOverwrites) {
      voiceChannelPermissionSnapshots.set(channelId, normalizePermissionSnapshot(savedChannel.permissionOverwrites));
    }

    if (voiceChannel.parentId === category.archiveCategoryId) {
      closeSavedActiveChannelSessions(savedChannel);
      voiceChannelOwners.delete(channelId);
      voiceChannelPermissionSnapshots.delete(channelId);
      delete botState.activeChannels[channelId];
      changedState = true;
      continue;
    }

    if (voiceChannel.parentId !== category.activeCategoryId) {
      console.warn(`Saved channel ${voiceChannel.name} is no longer in an active category. Removing it from state.`);
      closeSavedActiveChannelSessions(savedChannel);
      voiceChannelOwners.delete(channelId);
      voiceChannelPermissionSnapshots.delete(channelId);
      delete botState.activeChannels[channelId];
      changedState = true;
      continue;
    }

    const members = voiceChannel.members.filter((member) => !member.user.bot);
    if (members.size === 0) {
      await handleEmptyPoolChannel(voiceChannel);
      changedState = true;
      continue;
    }

    const savedOwner = savedChannel.ownerId && members.has(savedChannel.ownerId) ? members.get(savedChannel.ownerId) : null;
    const owner = savedOwner || members.first();
    const now = new Date();
    const ownerChanged = savedChannel.ownerId !== owner.id;
    const missingSessionStart = !savedChannel.ownerSessionStartedAt;
    const previousMemberSessions = normalizeActiveMemberSessions(savedChannel.memberSessions, owner.id);
    const memberSessions = syncMemberSessionsForVoiceChannel(voiceChannel, guild.id, owner.id, previousMemberSessions, now);
    const memberSessionsChanged = JSON.stringify(previousMemberSessions) !== JSON.stringify(memberSessions);
    voiceChannelOwners.set(channelId, owner.id);

    if (savedChannel.ownerId && ownerChanged) {
      closeSavedHostSession(savedChannel, now);
    }

    if (ownerChanged || missingSessionStart) {
      recordHostSessionStart(guild.id, owner.id, voiceChannel, now);
    }

    if (!savedOwner || savedChannel.guildId !== guild.id || ownerChanged || missingSessionStart || memberSessionsChanged) {
      botState.activeChannels[channelId] = {
        ...savedChannel,
        guildId: guild.id,
        channelName: voiceChannel.name,
        ownerId: owner.id,
        ownerSessionStartedAt: ownerChanged || missingSessionStart ? now.toISOString() : savedChannel.ownerSessionStartedAt,
        categoryName: category.name,
        requestChannelId: category.requestChannelId,
        activeCategoryId: category.activeCategoryId,
        archiveCategoryId: category.archiveCategoryId,
        memberSessions,
        updatedAt: now.toISOString(),
      };
      changedState = true;
    }

    console.log(`Restored owner ${owner.user.tag} for active voice channel ${voiceChannel.name}.`);
  }

  if (changedState) {
    saveState();
  }
}

function findAvailableArchiveChannel(category, guild) {
  const archiveCategoryId = category.archiveCategoryId;
  return guild.channels.cache
    .filter(
      (channel) =>
        channel.type === ChannelType.GuildVoice &&
        channel.parentId === archiveCategoryId &&
        channel.members.size === 0 &&
        poolChannelArchive.has(channel.id)
    )
    .sort((a, b) => a.position - b.position)
    .first();
}

function getSetupPoolCounts(category, guild) {
  const archiveChannels = guild.channels.cache.filter(
    (channel) => channel.parentId === category.archiveCategoryId && channel.type === ChannelType.GuildVoice
  );
  const availableChannels = archiveChannels.filter((channel) => channel.members.size === 0);
  const activeManagedChannels = Object.entries(botState.activeChannels || {})
    .filter(([, savedChannel]) => savedChannel.guildId === guild.id && savedChannel.requestChannelId === category.requestChannelId)
    .map(([channelId]) => guild.channels.cache.get(channelId))
    .filter((channel) => channel?.type === ChannelType.GuildVoice);

  return {
    archiveChannels,
    availableChannels,
    activeManagedChannels,
    totalManagedChannels: archiveChannels.size + activeManagedChannels.length,
  };
}

function buildAutoCreatedChannelName(category, guild) {
  const { totalManagedChannels } = getSetupPoolCounts(category, guild);
  const baseName = `${category.name || 'Voice'} Room`;
  const existingNames = new Set(guild.channels.cache.map((channel) => channel.name));

  for (let index = totalManagedChannels + 1; index <= totalManagedChannels + 100; index += 1) {
    const candidateName = `${baseName} ${index}`.slice(0, 100);
    if (!existingNames.has(candidateName)) {
      return candidateName;
    }
  }

  return `${baseName} ${Date.now()}`.slice(0, 100);
}

async function createArchiveChannelIfAllowed(category, guild) {
  if (!category.autoCreateArchiveRooms) {
    return null;
  }

  const archiveCategory = guild.channels.cache.get(category.archiveCategoryId);
  if (!archiveCategory || archiveCategory.type !== ChannelType.GuildCategory) {
    return null;
  }

  const { totalManagedChannels } = getSetupPoolCounts(category, guild);
  const maxArchiveRooms = category.maxArchiveRooms || 10;
  if (totalManagedChannels >= maxArchiveRooms) {
    console.warn(`Auto-create limit reached for ${category.name}: ${totalManagedChannels}/${maxArchiveRooms}.`);
    return null;
  }

  const channelName = buildAutoCreatedChannelName(category, guild);
  const createdChannel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildVoice,
    parent: archiveCategory.id,
    reason: `Auto-created archive room for ${category.name}`,
  });

  poolChannelArchive.set(createdChannel.id, { guildId: guild.id, archiveCategoryId: category.archiveCategoryId });
  console.log(`Auto-created archive voice channel ${createdChannel.name} for ${category.name}.`);
  return createdChannel;
}

function normalizeChannelName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function findTextChannelForVoiceChannel(voiceChannel, guild) {
  const baseName = normalizeChannelName(voiceChannel.name);
  const candidateNames = new Set([
    baseName,
    `${baseName}-chat`,
    `chat-${baseName}`,
    `${baseName}-voice-chat`,
    `${baseName}-vc-chat`,
    `${baseName}-text`,
    `${baseName}-vc`,
    `${baseName}-voice`,
  ]);

  const textChannels = guild.channels.cache.filter((channel) => channel.type === ChannelType.GuildText);
  const matchingTextChannel = textChannels.find((channel) => candidateNames.has(normalizeChannelName(channel.name)));

  if (matchingTextChannel) {
    return matchingTextChannel;
  }

  const sameCategoryChannel = textChannels
    .filter((channel) => channel.parentId === voiceChannel.parentId)
    .sort((a, b) => a.position - b.position)
    .first();

  if (sameCategoryChannel) {
    return sameCategoryChannel;
  }

  return textChannels.sort((a, b) => a.position - b.position).first();
}

function buildCapacitySelector(voiceChannelId) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`voice-capacity-select:${voiceChannelId}`)
    .setPlaceholder('Select a user limit')
    .addOptions([
      {
        label: 'Unlimited',
        value: '0',
      },
      ...Array.from({ length: 18 }, (_, index) => {
        const value = index + 3;
        return {
          label: `${value} users`,
          value: String(value),
        };
      }),
    ]);

  return new ActionRowBuilder().addComponents(menu);
}

function buildTransferOwnerSelector(voiceChannelId) {
  const menu = new UserSelectMenuBuilder()
    .setCustomId(`voice-transfer-select:${voiceChannelId}`)
    .setPlaceholder('Transfer ownership')
    .setMinValues(1)
    .setMaxValues(1);

  return new ActionRowBuilder().addComponents(menu);
}

function buildOwnerControlComponents(voiceChannelId) {
  return [
    buildCapacitySelector(voiceChannelId),
    buildTransferOwnerSelector(voiceChannelId),
  ];
}

function buildCapacityCard(currentLimit) {
  const current = currentLimit && currentLimit > 0 ? currentLimit : 'not set';
  return createCardAttachment({
    badge: 'CAP',
    title: 'Voice Channel Capacity',
    description: 'Choose how many users can join this voice channel.',
    fields: [{ name: 'Current limit', value: `${current}` }],
    footer: 'Only the channel owner or bot access role can change this setting.',
  }, 'capacity');
}

async function sendCapacitySelector(voiceChannel, ownerMember) {
  const card = buildCapacityCard(voiceChannel.userLimit || 0);
  const row = buildCapacitySelector(voiceChannel.id);

  const textChannel = findTextChannelForVoiceChannel(voiceChannel, voiceChannel.guild);
  if (textChannel) {
    try {
      await textChannel.send({
        content: `${ownerMember}`,
        files: [card],
        components: [row],
      });
      return true;
    } catch (error) {
      console.warn(`Could not send the capacity selector into ${textChannel.name}:`, error);
    }
  }

  try {
    await ownerMember.user.send({
      files: [buildCapacityCard(voiceChannel.userLimit || 0)],
      components: [row],
    });
    return true;
  } catch (error) {
    console.warn(`Could not DM the owner ${ownerMember.user.tag}:`, error);
    return false;
  }
}

function capturePermissionOverwrites(channel) {
  const cache = channel.permissionOverwrites && channel.permissionOverwrites.cache;
  if (!cache) return [];

  const mapper = (overwrite) => ({
    id: overwrite.id,
    type: overwrite.type,
    allow: overwrite.allow && overwrite.allow.bitfield ? String(overwrite.allow.bitfield) : String(overwrite.allow || 0),
    deny: overwrite.deny && overwrite.deny.bitfield ? String(overwrite.deny.bitfield) : String(overwrite.deny || 0),
  });

  if (typeof cache.map === 'function') {
    return cache.map(mapper);
  }

  if (cache instanceof Map) {
    return Array.from(cache.values()).map(mapper);
  }

  if (Array.isArray(cache)) {
    return cache.map(mapper);
  }

  return [];
}

async function restorePermissionOverwrites(channel, snapshot) {
  const normalizedSnapshot = normalizePermissionSnapshot(snapshot);
  if (normalizedSnapshot.length === 0) {
    return;
  }

  await channel.permissionOverwrites.set(normalizedSnapshot);
}

async function moveChannelToCategory(channel, categoryId) {
  if (channel.parentId === categoryId) {
    return channel;
  }
  return channel.setParent(categoryId, { lockPermissions: true });
}

async function restoreOriginalChannelName(channel) {
  const savedChannel = botState.activeChannels[channel.id];
  const originalChannelName = savedChannel?.originalChannelName;
  if (!originalChannelName || channel.name === originalChannelName) {
    return;
  }

  await channel.setName(originalChannelName);
}

async function assignVoiceChannelOwner(voiceChannel) {
  const members = voiceChannel.members.filter((member) => !member.user.bot);
  if (members.size === 0) {
    voiceChannelOwners.delete(voiceChannel.id);
    return null;
  }

  const currentOwnerId = voiceChannelOwners.get(voiceChannel.id);
  const firstMember = members.first();
  const nextOwner = currentOwnerId && members.has(currentOwnerId) ? members.get(currentOwnerId) : firstMember;

  if (!nextOwner) {
    voiceChannelOwners.delete(voiceChannel.id);
    return null;
  }

  rememberActiveChannel(voiceChannel, nextOwner.id);
  return nextOwner;
}

async function notifyNewOwner(voiceChannel, newOwner, options = {}) {
  if (!newOwner) {
    return;
  }

  const previousOwner = options.previousOwner || null;
  const moderator = options.moderator || null;
  const reason = options.reason || 'auto';
  const description =
    reason === 'override' && moderator
      ? `${moderator} made ${newOwner} the owner of this voice channel.`
      : reason === 'manual' && previousOwner
      ? `${previousOwner} transferred ownership to ${newOwner}.`
      : previousOwner
        ? `${previousOwner} left the room, so ${newOwner} is now the owner.`
        : `${newOwner} is now the owner of this voice channel.`;

  const card = createCardAttachment({
    badge: 'OWN',
    title: 'Voice Channel Owner Updated',
    description,
    fields: [{
      name: 'Owner controls',
      value: 'Use the user-limit selector below, or transfer ownership to another member in this room.',
    }],
    footer: 'Only the current room owner or bot access role can use these controls.',
  }, 'owner-updated');

  const components = buildOwnerControlComponents(voiceChannel.id);

  const textChannel = findTextChannelForVoiceChannel(voiceChannel, voiceChannel.guild);
  if (textChannel) {
    try {
      await textChannel.send({
        content: `${newOwner}`,
        files: [card],
        components,
      });
      return;
    } catch (error) {
      console.warn(`Could not send the owner update into ${textChannel.name}:`, error);
    }
  }

  try {
    await newOwner.user.send({
      files: [createCardAttachment({
        badge: 'OWN',
        title: 'Voice Channel Owner Updated',
        description,
        fields: [{
          name: 'Owner controls',
          value: 'Use the user-limit selector below, or transfer ownership to another member in this room.',
        }],
        footer: 'Only the current room owner or bot access role can use these controls.',
      }, 'owner-updated')],
      components,
    });
    return;
  } catch (error) {
    console.warn(`Could not DM the new owner ${newOwner.user.tag}:`, error);
  }
  if (textChannel) {
    await textChannel.send({
      content: `${newOwner}`,
      files: [createCardAttachment({
        badge: 'OWN',
        title: 'Voice Channel Owner Updated',
        description,
        fields: [{
          name: 'Owner controls',
          value: 'Use the user-limit selector below, or transfer ownership to another member in this room.',
        }],
        footer: 'Only the current room owner or bot access role can use these controls.',
      }, 'owner-updated')],
      components,
    }).catch(() => {});
    return;
  }

  await newOwner.user.send({
    files: [createCardAttachment({
      badge: 'OWN',
      title: 'Voice Channel Owner Updated',
      description,
      fields: [{
        name: 'Owner controls',
        value: 'Use the user-limit selector below, or transfer ownership to another member in this room.',
      }],
      footer: 'Only the current room owner or bot access role can use these controls.',
    }, 'owner-updated')],
  }).catch(() => {});
}

async function handleRequestChannelJoin(newState, category) {
  const guild = newState.guild;
  let availableChannel = findAvailableArchiveChannel(category, guild);
  if (!availableChannel) {
    availableChannel = await createArchiveChannelIfAllowed(category, guild).catch((error) => {
      console.error(`Failed to auto-create archive channel for ${category.name}:`, error);
      return null;
    });
  }

  if (!availableChannel) {
    console.warn(`No available archived channel in ${category.name} for request by ${newState.member.user.tag}.`);
    return;
  }

  try {
    const permissionSnapshot = capturePermissionOverwrites(availableChannel);
    voiceChannelPermissionSnapshots.set(availableChannel.id, permissionSnapshot);
    await moveChannelToCategory(availableChannel, category.activeCategoryId);
    await newState.setChannel(availableChannel);
    rememberActiveChannel(availableChannel, newState.member.id, category, permissionSnapshot);
    await sendCapacitySelector(availableChannel, newState.member);
    console.log(`Moved channel ${availableChannel.name} into ${category.name} and moved ${newState.member.user.tag} into it.`);
  } catch (error) {
    if (error?.code === 50001) {
      console.error('Missing access while moving the voice channel. Ensure the bot has Manage Channels and permission to edit the target category and channel.');
    } else {
      console.error('Failed to move channel or user:', error);
    }
  }
}

async function handleEmptyPoolChannel(oldChannel) {
  if (!oldChannel || !poolChannelArchive.has(oldChannel.id)) {
    return;
  }

  if (oldChannel.members.size !== 0) {
    return;
  }

  const poolEntry = poolChannelArchive.get(oldChannel.id);
  const archiveCategoryId = poolEntry?.archiveCategoryId;
  if (!archiveCategoryId) {
    return;
  }

  if (oldChannel.parentId === archiveCategoryId) {
    forgetActiveChannel(oldChannel.id);
    return;
  }

  try {
    await moveChannelToCategory(oldChannel, archiveCategoryId);
    const savedPermissions = voiceChannelPermissionSnapshots.get(oldChannel.id);
    if (savedPermissions) {
      await restorePermissionOverwrites(oldChannel, savedPermissions);
    }
    await restoreOriginalChannelName(oldChannel);
    forgetActiveChannel(oldChannel.id);
    console.log(`Moved empty channel ${oldChannel.name} back to archive category.`);
  } catch (error) {
    console.error('Failed to move empty pool channel back to archive:', error);
  }
}

function truncateFieldValue(value, maxLength = 1024) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function formatUserLimit(voiceChannel) {
  return voiceChannel.userLimit && voiceChannel.userLimit > 0 ? String(voiceChannel.userLimit) : 'unlimited';
}

function getManagedActiveVoiceRooms(guild) {
  const archiveCategoryIds = new Set(getConfiguredCategories(guild.id).map((category) => category.archiveCategoryId));
  return Object.entries(botState.activeChannels || {})
    .filter(([, savedChannel]) => savedChannel.guildId === guild.id)
    .map(([channelId, savedChannel]) => {
      const voiceChannel = guild.channels.cache.get(channelId);
      if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
        return null;
      }

      const archiveCategoryId = savedChannel.archiveCategoryId || poolChannelArchive.get(channelId)?.archiveCategoryId;
      if (archiveCategoryIds.size > 0 && !archiveCategoryIds.has(archiveCategoryId)) {
        return null;
      }

      return { voiceChannel, savedChannel };
    })
    .filter(Boolean)
    .sort((a, b) => a.voiceChannel.name.localeCompare(b.voiceChannel.name));
}

function truncateChoiceName(value) {
  return value.length <= 100 ? value : `${value.slice(0, 97)}...`;
}

function buildManagedTransferRoomChoices(guild, focusedValue = '') {
  const query = focusedValue.trim().toLowerCase();
  const rooms = getManagedActiveVoiceRooms(guild)
    .map(({ voiceChannel, savedChannel }) => {
      const ownerId = voiceChannelOwners.get(voiceChannel.id) || savedChannel.ownerId;
      const owner = ownerId ? guild.members.cache.get(ownerId) : null;
      const memberCount = voiceChannel.members.filter((member) => !member.user.bot).size;
      const setupName = savedChannel.categoryName || 'Voice setup';
      const searchText = [
        voiceChannel.name,
        voiceChannel.id,
        setupName,
        owner?.user?.tag || '',
        ownerId || '',
      ].join(' ').toLowerCase();

      return {
        name: truncateChoiceName(`${voiceChannel.name} - ${setupName} - owner ${owner?.user?.tag || ownerId || 'unknown'} - ${memberCount} user(s)`),
        value: voiceChannel.id,
        searchText,
      };
    })
    .filter((choice) => !query || choice.searchText.includes(query));

  return rooms.slice(0, 25).map(({ name, value }) => ({ name, value }));
}

function buildRoomsCard(guild) {
  const configuredCategories = getConfiguredCategories(guild.id);
  const activeRoomLines = getManagedActiveVoiceRooms(guild)
    .map(({ voiceChannel, savedChannel }) => {
      const ownerId = voiceChannelOwners.get(voiceChannel.id) || savedChannel.ownerId;
      const owner = ownerId ? guild.members.cache.get(ownerId) : null;
      const ownerLabel = owner?.user?.tag || ownerId || 'unknown';
      const memberCount = voiceChannel.members.filter((member) => !member.user.bot).size;
      const setupName = savedChannel.categoryName || 'Voice setup';
      return `${voiceChannel.name} - owner ${ownerLabel} - ${memberCount}/${formatUserLimit(voiceChannel)} users - ${setupName}`;
    })
    .filter(Boolean);

  const archivePoolLines = configuredCategories.map((category) => {
    const { archiveChannels, availableChannels, totalManagedChannels } = getSetupPoolCounts(category, guild);
    const autoCreateText = category.autoCreateArchiveRooms
      ? `, auto-create on up to ${category.maxArchiveRooms} total`
      : ', auto-create off';
    return `${category.name}: ${availableChannels.size}/${archiveChannels.size} archived rooms available (${totalManagedChannels} managed${autoCreateText})`;
  });

  return createCardAttachment({
    badge: 'RMS',
    title: 'Voice Rooms',
    description: `${activeRoomLines.length} active room(s).`,
    fields: [
      {
        name: 'Active Rooms',
        value: truncateFieldValue(activeRoomLines.length > 0 ? activeRoomLines.join('\n') : 'No active rooms right now.'),
      },
      {
        name: 'Archive Pools',
        value: truncateFieldValue(archivePoolLines.length > 0 ? archivePoolLines.join('\n') : 'No setups saved yet.'),
      },
    ],
  }, 'voice-rooms');
}

function channelMention(channel, channelId) {
  if (channel) {
    return channel.name;
  }

  return channelId ? `<#${channelId}>` : 'Not connected';
}

function buildVoiceActivityLogCard(member, oldState, newState) {
  if (!member || oldState.channelId === newState.channelId) {
    return null;
  }

  const oldChannel = oldState.channel;
  const newChannel = newState.channel;
  const oldChannelLabel = channelMention(oldChannel, oldState.channelId);
  const newChannelLabel = channelMention(newChannel, newState.channelId);
  const memberLabel = `${member} (${member.user.tag})`;

  if (!oldState.channelId && newState.channelId) {
    return createCardAttachment({
      badge: 'JOIN',
      title: 'Voice Channel Joined',
      description: `${member} joined ${newChannelLabel}.`,
      fields: [
        { name: 'Member', value: memberLabel, inline: false },
        { name: 'Channel', value: newChannelLabel, inline: true },
      ],
      footer: `User ID: ${member.id}`,
      color: [87, 242, 135, 255],
    }, 'voice-joined');
  }

  if (oldState.channelId && !newState.channelId) {
    return createCardAttachment({
      badge: 'LEFT',
      title: 'Voice Channel Left',
      description: `${member} left ${oldChannelLabel}.`,
      fields: [
        { name: 'Member', value: memberLabel, inline: false },
        { name: 'Channel', value: oldChannelLabel, inline: true },
      ],
      footer: `User ID: ${member.id}`,
      color: [237, 66, 69, 255],
    }, 'voice-left');
  }

  return createCardAttachment({
    badge: 'MOVE',
    title: 'Voice Channel Moved',
    description: `${member} moved from ${oldChannelLabel} to ${newChannelLabel}.`,
    fields: [
      { name: 'Member', value: memberLabel, inline: false },
      { name: 'From', value: oldChannelLabel, inline: true },
      { name: 'To', value: newChannelLabel, inline: true },
    ],
    footer: `User ID: ${member.id}`,
    color: [254, 231, 92, 255],
  }, 'voice-moved');
}

async function sendVoiceActivityLog(oldState, newState) {
  const guild = newState.guild || oldState.guild;
  if (!guild || oldState.channelId === newState.channelId) {
    return;
  }

  const member = newState.member || oldState.member;
  if (!member || member.user.bot) {
    return;
  }

  const settings = getVoiceLogSettings(guild.id);
  if (!settings.enabled || !settings.channelId) {
    return;
  }

  const logChannel =
    guild.channels.cache.get(settings.channelId) ||
    await guild.channels.fetch(settings.channelId).catch(() => null);

  if (!logChannel || logChannel.type !== ChannelType.GuildText) {
    console.warn(`Voice logging is enabled for ${guild.name}, but the saved log channel could not be found.`);
    return;
  }

  const card = buildVoiceActivityLogCard(member, oldState, newState);
  if (!card) {
    return;
  }

  await logChannel.send({ files: [card] }).catch((error) => {
    console.warn(`Could not send voice activity log in ${guild.name}:`, error);
  });
}

const pixelFont = {
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  '!': ['00100', '00100', '00100', '00100', '00100', '00000', '00100'],
  '"': ['01010', '01010', '01010', '00000', '00000', '00000', '00000'],
  '#': ['01010', '01010', '11111', '01010', '11111', '01010', '01010'],
  '%': ['11001', '11010', '00100', '01000', '10110', '00110', '00000'],
  '&': ['01100', '10010', '10100', '01000', '10101', '10010', '01101'],
  "'": ['00100', '00100', '01000', '00000', '00000', '00000', '00000'],
  '(': ['00010', '00100', '01000', '01000', '01000', '00100', '00010'],
  ')': ['01000', '00100', '00010', '00010', '00010', '00100', '01000'],
  '*': ['00000', '10101', '01110', '11111', '01110', '10101', '00000'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
  ',': ['00000', '00000', '00000', '00000', '00100', '00100', '01000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  '/': ['00001', '00010', '00100', '01000', '10000', '00000', '00000'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  ';': ['00000', '01100', '01100', '00000', '01100', '00100', '01000'],
  '<': ['00010', '00100', '01000', '10000', '01000', '00100', '00010'],
  '=': ['00000', '00000', '11111', '00000', '11111', '00000', '00000'],
  '>': ['01000', '00100', '00010', '00001', '00010', '00100', '01000'],
  '?': ['01110', '10001', '00001', '00010', '00100', '00000', '00100'],
  '@': ['01110', '10001', '10111', '10101', '10111', '10000', '01110'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  J: ['00001', '00001', '00001', '00001', '10001', '10001', '01110'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '[': ['01110', '01000', '01000', '01000', '01000', '01000', '01110'],
  '\\': ['10000', '01000', '00100', '00010', '00001', '00000', '00000'],
  ']': ['01110', '00010', '00010', '00010', '00010', '00010', '01110'],
  '`': ['01000', '00100', '00000', '00000', '00000', '00000', '00000'],
  '_': ['00000', '00000', '00000', '00000', '00000', '00000', '11111'],
  a: ['00000', '00000', '01110', '00001', '01111', '10001', '01111'],
  b: ['10000', '10000', '10110', '11001', '10001', '10001', '11110'],
  c: ['00000', '00000', '01110', '10001', '10000', '10001', '01110'],
  d: ['00001', '00001', '01101', '10011', '10001', '10001', '01111'],
  e: ['00000', '00000', '01110', '10001', '11111', '10000', '01110'],
  f: ['00110', '01001', '01000', '11100', '01000', '01000', '01000'],
  g: ['00000', '00000', '01111', '10001', '01111', '00001', '01110'],
  h: ['10000', '10000', '10110', '11001', '10001', '10001', '10001'],
  i: ['00100', '00000', '01100', '00100', '00100', '00100', '01110'],
  j: ['00010', '00000', '00110', '00010', '00010', '10010', '01100'],
  k: ['10000', '10000', '10010', '10100', '11000', '10100', '10010'],
  l: ['01100', '00100', '00100', '00100', '00100', '00100', '01110'],
  m: ['00000', '00000', '11010', '10101', '10101', '10101', '10101'],
  n: ['00000', '00000', '10110', '11001', '10001', '10001', '10001'],
  o: ['00000', '00000', '01110', '10001', '10001', '10001', '01110'],
  p: ['00000', '00000', '11110', '10001', '11110', '10000', '10000'],
  q: ['00000', '00000', '01111', '10001', '01111', '00001', '00001'],
  r: ['00000', '00000', '10110', '11001', '10000', '10000', '10000'],
  s: ['00000', '00000', '01111', '10000', '01110', '00001', '11110'],
  t: ['01000', '01000', '11100', '01000', '01000', '01001', '00110'],
  u: ['00000', '00000', '10001', '10001', '10001', '10011', '01101'],
  v: ['00000', '00000', '10001', '10001', '10001', '01010', '00100'],
  w: ['00000', '00000', '10001', '10001', '10101', '10101', '01010'],
  x: ['00000', '00000', '10001', '01010', '00100', '01010', '10001'],
  y: ['00000', '00000', '10001', '10001', '01111', '00001', '01110'],
  z: ['00000', '00000', '11111', '00010', '00100', '01000', '11111'],
};

const pngCrcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function pngCrc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = pngCrcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createPngChunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const lengthBuffer = Buffer.alloc(4);
  const crcBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(data.length, 0);
  crcBuffer.writeUInt32BE(pngCrc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([lengthBuffer, typeBuffer, data, crcBuffer]);
}

function encodePng(width, height, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;

  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const scanlineStart = y * (width * 4 + 1);
    scanlines[scanlineStart] = 0;
    pixels.copy(scanlines, scanlineStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    createPngChunk('IHDR', header),
    createPngChunk('IDAT', zlib.deflateSync(scanlines)),
    createPngChunk('IEND'),
  ]);
}

function setImagePixel(pixels, width, height, x, y, color) {
  if (x < 0 || y < 0 || x >= width || y >= height) {
    return;
  }

  const offset = (y * width + x) * 4;
  pixels[offset] = color[0];
  pixels[offset + 1] = color[1];
  pixels[offset + 2] = color[2];
  pixels[offset + 3] = color[3] ?? 255;
}

function drawImageRect(pixels, width, height, x, y, rectWidth, rectHeight, color) {
  for (let row = Math.max(0, y); row < Math.min(height, y + rectHeight); row += 1) {
    for (let column = Math.max(0, x); column < Math.min(width, x + rectWidth); column += 1) {
      setImagePixel(pixels, width, height, column, row, color);
    }
  }
}

function isInRoundedRect(column, row, x, y, rectWidth, rectHeight, radius) {
  const roundedRadius = Math.max(0, Math.min(radius, Math.floor(Math.min(rectWidth, rectHeight) / 2)));
  if (roundedRadius === 0) {
    return true;
  }

  const left = x;
  const right = x + rectWidth - 1;
  const top = y;
  const bottom = y + rectHeight - 1;
  let centerX = column;
  let centerY = row;

  if (column < left + roundedRadius) {
    centerX = left + roundedRadius;
  } else if (column > right - roundedRadius) {
    centerX = right - roundedRadius;
  }

  if (row < top + roundedRadius) {
    centerY = top + roundedRadius;
  } else if (row > bottom - roundedRadius) {
    centerY = bottom - roundedRadius;
  }

  const deltaX = column - centerX;
  const deltaY = row - centerY;
  return deltaX * deltaX + deltaY * deltaY <= roundedRadius * roundedRadius;
}

function drawImageRoundedRect(pixels, width, height, x, y, rectWidth, rectHeight, radius, color) {
  for (let row = Math.max(0, y); row < Math.min(height, y + rectHeight); row += 1) {
    for (let column = Math.max(0, x); column < Math.min(width, x + rectWidth); column += 1) {
      if (isInRoundedRect(column, row, x, y, rectWidth, rectHeight, radius)) {
        setImagePixel(pixels, width, height, column, row, color);
      }
    }
  }
}

function drawImageRoundedAccentPanel(pixels, width, height, x, y, rectWidth, rectHeight, panelColor, accentColor) {
  drawImageRoundedRect(pixels, width, height, x, y, rectWidth, rectHeight, cardTheme.panelRadius, panelColor);

  for (let row = Math.max(0, y); row < Math.min(height, y + rectHeight); row += 1) {
    for (let column = Math.max(0, x); column < Math.min(width, x + 10); column += 1) {
      if (isInRoundedRect(column, row, x, y, rectWidth, rectHeight, cardTheme.panelRadius)) {
        setImagePixel(pixels, width, height, column, row, accentColor);
      }
    }
  }
}

function normalizeImageColor(color, fallback = cardTheme.accent) {
  if (!Array.isArray(color)) {
    return fallback;
  }

  return [
    Number.isFinite(Number(color[0])) ? Math.max(0, Math.min(255, Math.floor(Number(color[0])))) : fallback[0],
    Number.isFinite(Number(color[1])) ? Math.max(0, Math.min(255, Math.floor(Number(color[1])))) : fallback[1],
    Number.isFinite(Number(color[2])) ? Math.max(0, Math.min(255, Math.floor(Number(color[2])))) : fallback[2],
    Number.isFinite(Number(color[3])) ? Math.max(0, Math.min(255, Math.floor(Number(color[3])))) : 255,
  ];
}

function normalizeImageProgress(progress) {
  if (!progress || typeof progress !== 'object') {
    return null;
  }

  const percent = Number(progress.percent);
  if (!Number.isFinite(percent)) {
    return null;
  }

  return Math.min(1, Math.max(0, percent));
}

function drawImageProgressBar(pixels, width, height, x, y, rectWidth, rectHeight, progressPercent, accentColor) {
  const percent = Math.min(1, Math.max(0, Number(progressPercent) || 0));
  const radius = Math.floor(rectHeight / 2);
  const inset = 4;
  const innerWidth = Math.max(0, rectWidth - inset * 2);
  const innerHeight = Math.max(0, rectHeight - inset * 2);
  const fillColor = normalizeImageColor(accentColor);

  drawImageRoundedRect(pixels, width, height, x, y, rectWidth, rectHeight, radius, [51, 65, 85, 255]);

  if (innerWidth <= 0 || innerHeight <= 0 || percent <= 0) {
    return;
  }

  const rawFillWidth = percent >= 1 ? innerWidth : Math.floor(innerWidth * percent);
  const fillWidth = Math.min(innerWidth, Math.max(innerHeight, rawFillWidth));
  drawImageRoundedRect(pixels, width, height, x + inset, y + inset, fillWidth, innerHeight, Math.floor(innerHeight / 2), fillColor);
}

function sanitizeImageText(value) {
  return String(value ?? '')
    .replace(/<@!?(\d+)>/g, '@USER')
    .replace(/<#(\d+)>/g, '#CHANNEL')
    .replace(/[^\x20-\x7e]/g, '?');
}

function wrapImageText(value, maxCharacters) {
  const words = sanitizeImageText(value).split(/\s+/).filter(Boolean);
  const lines = [];
  let currentLine = '';

  for (const word of words) {
    if (word.length > maxCharacters) {
      if (currentLine) {
        lines.push(currentLine);
        currentLine = '';
      }

      for (let index = 0; index < word.length; index += maxCharacters) {
        lines.push(word.slice(index, index + maxCharacters));
      }
      continue;
    }

    const nextLine = currentLine ? `${currentLine} ${word}` : word;
    if (nextLine.length > maxCharacters && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = nextLine;
    }
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines.length > 0 ? lines : [''];
}

function drawImageText(pixels, width, height, text, x, y, scale, color) {
  let cursorX = x;
  for (const character of sanitizeImageText(text)) {
    const glyph = pixelFont[character] || pixelFont['?'];
    for (let row = 0; row < glyph.length; row += 1) {
      for (let column = 0; column < glyph[row].length; column += 1) {
        if (glyph[row][column] === '1') {
          drawImageRect(pixels, width, height, cursorX + column * scale, y + row * scale, scale, scale, color);
        }
      }
    }
    cursorX += 6 * scale;
  }
}

function measureImageText(text, scale) {
  return sanitizeImageText(text).length * 6 * scale;
}

function truncateImageText(value, maxCharacters) {
  const text = sanitizeImageText(value);
  if (text.length <= maxCharacters) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxCharacters - 3))}...`;
}

function drawImageTextRight(pixels, width, height, text, x, y, rectWidth, scale, color) {
  const maxCharacters = Math.max(1, Math.floor(rectWidth / (6 * scale)));
  const truncatedText = truncateImageText(text, maxCharacters);
  drawImageText(pixels, width, height, truncatedText, x + rectWidth - measureImageText(truncatedText, scale), y, scale, color);
}

function drawWrappedImageText(pixels, width, height, lines, x, y, scale, color) {
  let cursorY = y;
  const lineHeight = 10 * scale;
  for (const line of lines) {
    drawImageText(pixels, width, height, line, x, cursorY, scale, color);
    cursorY += lineHeight;
  }
  return cursorY;
}

function createModeratorAuditImage(auditEntry, fields) {
  const width = 1500;
  const padding = 60;
  const valueScale = 4;
  const labelScale = 3;
  const maxValueCharacters = Math.floor((width - padding * 2 - 28) / (6 * valueScale));
  const detailRows = fields.map((field) => ({
    label: field.name,
    lines: wrapImageText(field.value, maxValueCharacters),
  }));
  const baseHeight = 240;
  const rowsHeight = detailRows.reduce((total, row) => total + 58 + row.lines.length * 40, 0);
  const height = Math.max(520, baseHeight + rowsHeight + padding);
  const pixels = Buffer.alloc(width * height * 4);

  drawImageRect(pixels, width, height, 0, 0, width, height, [17, 24, 39, 255]);
  drawImageRect(pixels, width, height, 0, 0, width, 18, cardTheme.accent);
  drawImageRect(pixels, width, height, padding, 58, 116, 116, cardTheme.accent);
  drawImageText(pixels, width, height, 'MR', padding + 25, 101, 5, [255, 255, 255, 255]);
  drawImageText(pixels, width, height, 'MODERATOR ROOM ACTION', padding + 145, 64, 5, [248, 250, 252, 255]);
  drawImageText(pixels, width, height, auditEntry.action, padding + 145, 122, 4, cardTheme.subtitle);
  drawImageText(pixels, width, height, new Date().toLocaleString('en-GB'), padding + 145, 172, 3, [148, 163, 184, 255]);

  let cursorY = 232;
  for (const row of detailRows) {
    const boxHeight = 54 + row.lines.length * 40;
    drawImageRoundedAccentPanel(
      pixels,
      width,
      height,
      padding,
      cursorY,
      width - padding * 2,
      boxHeight,
      [31, 41, 55, 255],
      cardTheme.accent
    );
    drawImageText(pixels, width, height, row.label, padding + 28, cursorY + 18, labelScale, cardTheme.label);
    drawWrappedImageText(pixels, width, height, row.lines, padding + 28, cursorY + 56, valueScale, [248, 250, 252, 255]);
    cursorY += boxHeight + 22;
  }

  return encodePng(width, height, pixels);
}

function createBotCardImage(card) {
  const width = 1500;
  const padding = 60;
  const valueScale = 4;
  const labelScale = 3;
  const footerScale = 3;
  const maxValueCharacters = Math.floor((width - padding * 2 - 28) / (6 * valueScale));
  const descriptionLines = card.description ? wrapImageText(card.description, maxValueCharacters) : [];
  const detailRows = (card.fields || []).map((field) => ({
    label: field.name,
    lines: wrapImageText(field.value, maxValueCharacters),
    progress: normalizeImageProgress(field.progress),
  }));
  const descriptionHeight = descriptionLines.length > 0 ? 42 + descriptionLines.length * 40 : 0;
  const rowsHeight = detailRows.reduce((total, row) => total + 58 + row.lines.length * 40 + (row.progress !== null ? 62 : 0), 0);
  const timestampText = new Date().toLocaleString('en-GB');
  const timestampInFooter = card.timestampPlacement === 'footer';
  const showHeaderTimestamp = !timestampInFooter && card.showHeaderTimestamp !== false;
  const footerLeft = card.footerLeft || card.footer || (timestampInFooter ? timestampText : null);
  const footerRight = card.footerRight || null;
  const footerHeight = card.footer || footerLeft || footerRight ? 64 : 0;
  const headerBase = showHeaderTimestamp ? 230 : 204;
  const height = Math.max(480, headerBase + descriptionHeight + rowsHeight + footerHeight + padding);
  const pixels = Buffer.alloc(width * height * 4);
  const badge = card.badge || 'BOT';
  const title = card.title || 'Voice Room Bot';

  drawImageRect(pixels, width, height, 0, 0, width, height, [17, 24, 39, 255]);
  drawImageRect(pixels, width, height, 0, 0, width, 18, card.color || cardTheme.accent);
  drawImageRect(pixels, width, height, padding, 58, 116, 116, card.color || cardTheme.accent);
  drawImageText(pixels, width, height, badge.slice(0, 3), padding + 22, 101, 5, [255, 255, 255, 255]);
  drawImageText(pixels, width, height, title, padding + 145, 64, 5, [248, 250, 252, 255]);

  if (card.subtitle) {
    drawImageText(pixels, width, height, card.subtitle, padding + 145, 122, 4, cardTheme.subtitle);
  }

  if (showHeaderTimestamp) {
    drawImageText(pixels, width, height, timestampText, padding + 145, 172, 3, [148, 163, 184, 255]);
  }

  let cursorY = showHeaderTimestamp ? 232 : 206;
  if (descriptionLines.length > 0) {
    drawImageRoundedRect(pixels, width, height, padding, cursorY, width - padding * 2, descriptionHeight, cardTheme.panelRadius, [30, 41, 59, 255]);
    cursorY = drawWrappedImageText(pixels, width, height, descriptionLines, padding + 28, cursorY + 26, valueScale, [226, 232, 240, 255]) + 24;
  }

  for (const row of detailRows) {
    const hasProgress = row.progress !== null;
    const boxHeight = 54 + row.lines.length * 40 + (hasProgress ? 62 : 0);
    drawImageRoundedAccentPanel(
      pixels,
      width,
      height,
      padding,
      cursorY,
      width - padding * 2,
      boxHeight,
      [31, 41, 55, 255],
      card.color || cardTheme.accent
    );
    drawImageText(pixels, width, height, row.label, padding + 28, cursorY + 18, labelScale, cardTheme.label);
    const textBottom = drawWrappedImageText(pixels, width, height, row.lines, padding + 28, cursorY + 56, valueScale, [248, 250, 252, 255]);

    if (hasProgress) {
      drawImageProgressBar(
        pixels,
        width,
        height,
        padding + 28,
        textBottom + 12,
        width - padding * 2 - 56,
        32,
        row.progress,
        card.color || cardTheme.accent
      );
    }

    cursorY += boxHeight + 22;
  }

  if (card.footer || footerLeft || footerRight) {
    const footerY = height - 52;
    if (footerLeft) {
      drawImageText(pixels, width, height, footerLeft, padding, footerY, footerScale, [148, 163, 184, 255]);
    }

    if (footerRight) {
      drawImageTextRight(pixels, width, height, footerRight, padding + Math.floor((width - padding * 2) / 2), footerY, Math.floor((width - padding * 2) / 2), footerScale, [148, 163, 184, 255]);
    }
  }

  return encodePng(width, height, pixels);
}

function findPowerShellExecutable() {
  if (process.platform === 'win32') {
    return 'powershell.exe';
  }

  return 'pwsh';
}

function getBotAvatarUrl() {
  return client.user?.displayAvatarURL({ extension: 'png', size: 128 }) || null;
}

function renderCardImage(card) {
  const rendererPath = path.join(__dirname, 'render-card.ps1');
  if (systemFontRendererAvailable === false || !fs.existsSync(rendererPath)) {
    return null;
  }

  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'server-bot-card-'));
  const inputPath = path.join(tempDirectory, 'card.json');
  const outputPath = path.join(tempDirectory, 'card.png');

  try {
    const cardWithAvatar = {
      ...card,
      avatarUrl: card.avatarUrl || getBotAvatarUrl(),
    };
    fs.writeFileSync(inputPath, JSON.stringify(cardWithAvatar), 'utf8');
    const result = spawnSync(findPowerShellExecutable(), [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      rendererPath,
      inputPath,
      outputPath,
    ], {
      encoding: 'utf8',
      timeout: 7000,
      windowsHide: true,
    });

    if (result.status !== 0 || !fs.existsSync(outputPath)) {
      if (result.stderr) {
        console.warn('System font card renderer failed:', result.stderr.trim());
      }
      systemFontRendererAvailable = false;
      return null;
    }

    systemFontRendererAvailable = true;
    return fs.readFileSync(outputPath);
  } catch (error) {
    console.warn('System font card renderer failed:', error);
    systemFontRendererAvailable = false;
    return null;
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
}

function getPureImageRenderer() {
  if (pureImageRendererAvailable === false) {
    return null;
  }

  if (pureImageRenderer) {
    return pureImageRenderer;
  }

  try {
    pureImageRenderer = require('pureimage');
    pureImageRendererAvailable = true;
    return pureImageRenderer;
  } catch (error) {
    console.warn('Pure image card renderer is not available:', error.message || error);
    pureImageRendererAvailable = false;
    return null;
  }
}

function firstExistingPath(paths) {
  return paths.find((candidatePath) => candidatePath && fs.existsSync(candidatePath)) || null;
}

function loadPureImageFonts(pureImage) {
  if (pureImageFontsLoaded) {
    return true;
  }

  const regularFontPath = firstExistingPath([
    path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'segoeui.ttf'),
    path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'arial.ttf'),
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf',
  ]);
  const boldFontPath = firstExistingPath([
    path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'segoeuib.ttf'),
    path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'arialbd.ttf'),
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf',
    regularFontPath,
  ]);

  if (!regularFontPath || !boldFontPath) {
    console.warn('Readable image card renderer could not find a usable system font.');
    return false;
  }

  try {
    pureImage.registerFont(regularFontPath, 'CardRegular').loadSync();
    pureImage.registerFont(boldFontPath, 'CardBold').loadSync();
    pureImageFontsLoaded = true;
    return true;
  } catch (error) {
    console.warn('Readable image card renderer could not load system fonts:', error);
    return false;
  }
}

function cardText(value) {
  return String(value ?? '')
    .replace(/<@!?(\d+)>/g, '@User')
    .replace(/<@&(\d+)>/g, '@Role')
    .replace(/<#(\d+)>/g, '#Channel')
    .replace(/[\r\t]+/g, ' ')
    .replace(/[^\x20-\x7e\n]/g, '?')
    .trim();
}

function setCanvasFont(context, family, size) {
  context.font = `${size}pt ${family}`;
}

function measureCanvasText(context, text, family, size) {
  setCanvasFont(context, family, size);
  return context.measureText(text).width || 0;
}

function wrapCanvasText(context, value, family, size, maxWidth) {
  const text = cardText(value);
  if (!text) {
    return [''];
  }

  const lines = [];
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let currentLine = '';

    for (const word of words) {
      const nextLine = currentLine ? `${currentLine} ${word}` : word;
      if (measureCanvasText(context, nextLine, family, size) <= maxWidth) {
        currentLine = nextLine;
        continue;
      }

      if (currentLine) {
        lines.push(currentLine);
        currentLine = '';
      }

      if (measureCanvasText(context, word, family, size) <= maxWidth) {
        currentLine = word;
        continue;
      }

      let fragment = '';
      for (const character of word) {
        const nextFragment = `${fragment}${character}`;
        if (measureCanvasText(context, nextFragment, family, size) <= maxWidth) {
          fragment = nextFragment;
        } else {
          if (fragment) {
            lines.push(fragment);
          }
          fragment = character;
        }
      }
      currentLine = fragment;
    }

    if (currentLine) {
      lines.push(currentLine);
    }
  }

  return lines.length > 0 ? lines : [''];
}

function fillCanvasRoundedRect(context, x, y, width, height, radius, fillStyle) {
  const roundedRadius = Math.max(0, Math.min(radius, Math.floor(Math.min(width, height) / 2)));
  context.fillStyle = fillStyle;
  context.beginPath();
  context.moveTo(x + roundedRadius, y);
  context.lineTo(x + width - roundedRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + roundedRadius);
  context.lineTo(x + width, y + height - roundedRadius);
  context.quadraticCurveTo(x + width, y + height, x + width - roundedRadius, y + height);
  context.lineTo(x + roundedRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - roundedRadius);
  context.lineTo(x, y + roundedRadius);
  context.quadraticCurveTo(x, y, x + roundedRadius, y);
  context.closePath();
  context.fill();
}

function drawCanvasLines(context, lines, x, y, family, size, lineHeight, fillStyle, maxLines = null) {
  setCanvasFont(context, family, size);
  context.fillStyle = fillStyle;
  const visibleLines = Number.isInteger(maxLines) ? lines.slice(0, maxLines) : lines;
  for (let index = 0; index < visibleLines.length; index += 1) {
    const line = index === visibleLines.length - 1 && maxLines && lines.length > maxLines
      ? `${visibleLines[index].slice(0, Math.max(0, visibleLines[index].length - 3))}...`
      : visibleLines[index];
    context.fillText(line, x, y + (index * lineHeight));
  }
}

function normalizeCssColor(color, fallback = cardTheme.accent) {
  const normalized = normalizeImageColor(color, fallback);
  return `rgb(${normalized[0]}, ${normalized[1]}, ${normalized[2]})`;
}

function fetchUrlBuffer(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (!url || redirectCount > 3) {
      reject(new Error('Invalid image URL'));
      return;
    }

    const request = https.get(url, {
      timeout: 4000,
      headers: { 'User-Agent': 'Voice Bot image renderer' },
    }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        fetchUrlBuffer(new URL(response.headers.location, url).toString(), redirectCount + 1)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`Image request failed with status ${response.statusCode}`));
        return;
      }

      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
    });

    request.on('timeout', () => request.destroy(new Error('Image request timed out')));
    request.on('error', reject);
  });
}

async function loadPureImageAvatar(pureImage, avatarUrl) {
  if (!avatarUrl) {
    return null;
  }

  try {
    const avatarBuffer = await fetchUrlBuffer(avatarUrl);
    const stream = Readable.from(avatarBuffer);
    const isJpeg = avatarBuffer[0] === 0xff && avatarBuffer[1] === 0xd8;
    return isJpeg
      ? await pureImage.decodeJPEGFromStream(stream)
      : await pureImage.decodePNGFromStream(stream);
  } catch (error) {
    console.warn('Could not load bot avatar for image card:', error.message || error);
    return null;
  }
}

function drawPureImageAvatar(context, avatarImage, x, y, size, accentColor) {
  context.fillStyle = accentColor;
  context.beginPath();
  context.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  context.fill();

  if (!avatarImage) {
    return false;
  }

  context.save();
  context.beginPath();
  context.arc(x + size / 2, y + size / 2, size / 2 - 3, 0, Math.PI * 2);
  context.clip();
  context.drawImage(avatarImage, x, y, size, size);
  context.restore();
  return true;
}

async function encodePureImagePng(pureImage, image) {
  return new Promise((resolve, reject) => {
    const outputStream = new PassThrough();
    const chunks = [];
    outputStream.on('data', (chunk) => chunks.push(chunk));
    outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    outputStream.on('error', reject);
    pureImage.encodePNGToStream(image, outputStream).catch(reject);
  });
}

async function renderPureImageHelpCard(card) {
  const pureImage = getPureImageRenderer();
  if (!pureImage || !loadPureImageFonts(pureImage)) {
    return null;
  }

  const width = 1500;
  const padding = 60;
  const contentWidth = width - padding * 2;
  const accentColor = normalizeCssColor(card.color || cardTheme.accent);
  const colors = {
    background: 'rgb(17, 24, 39)',
    panel: 'rgb(31, 41, 55)',
    panelSoft: 'rgb(30, 41, 59)',
    text: 'rgb(248, 250, 252)',
    muted: 'rgb(148, 163, 184)',
    label: 'rgb(253, 186, 116)',
    subtitle: 'rgb(254, 215, 170)',
  };
  const fonts = {
    title: { family: 'CardBold', size: 44, lineHeight: 54 },
    subtitle: { family: 'CardRegular', size: 32, lineHeight: 40 },
    label: { family: 'CardBold', size: 24, lineHeight: 32 },
    body: { family: 'CardRegular', size: 34, lineHeight: 44 },
    footer: { family: 'CardRegular', size: 24, lineHeight: 32 },
    badge: { family: 'CardBold', size: 38, lineHeight: 48 },
  };

  const measureImage = pureImage.make(1, 1);
  const measureContext = measureImage.getContext('2d');
  const descriptionLines = card.description
    ? wrapCanvasText(measureContext, card.description, fonts.body.family, fonts.body.size, contentWidth - 56)
    : [];
  const rows = (card.fields || []).map((field) => {
    const labelLines = wrapCanvasText(measureContext, field.name, fonts.label.family, fonts.label.size, contentWidth - 56);
    const valueLines = wrapCanvasText(measureContext, field.value, fonts.body.family, fonts.body.size, contentWidth - 56);
    const height = 34 + (labelLines.length * fonts.label.lineHeight) + 14 + (valueLines.length * fonts.body.lineHeight) + 22;
    return { labelLines, valueLines, height };
  });
  const descriptionHeight = descriptionLines.length > 0
    ? 32 + (descriptionLines.length * fonts.body.lineHeight)
    : 0;
  const rowsHeight = rows.reduce((total, row) => total + row.height + 22, 0);
  const footerHeight = 76;
  const height = Math.max(520, 214 + descriptionHeight + rowsHeight + footerHeight + padding);
  const image = pureImage.make(width, height);
  const context = image.getContext('2d');

  context.fillStyle = colors.background;
  context.fillRect(0, 0, width, height);
  context.fillStyle = accentColor;
  context.fillRect(0, 0, width, 18);

  const avatarImage = await loadPureImageAvatar(pureImage, getBotAvatarUrl());
  const drewAvatar = drawPureImageAvatar(context, avatarImage, padding, 58, 116, accentColor);
  if (!drewAvatar) {
    setCanvasFont(context, fonts.badge.family, fonts.badge.size);
    context.fillStyle = colors.text;
    context.fillText(card.badge || 'BOT', padding + 24, 126);
  }

  drawCanvasLines(
    context,
    wrapCanvasText(measureContext, card.title || 'Voice Room Bot', fonts.title.family, fonts.title.size, contentWidth - 145),
    padding + 145,
    98,
    fonts.title.family,
    fonts.title.size,
    fonts.title.lineHeight,
    colors.text,
    1
  );

  if (card.subtitle) {
    drawCanvasLines(
      context,
      wrapCanvasText(measureContext, card.subtitle, fonts.subtitle.family, fonts.subtitle.size, contentWidth - 145),
      padding + 145,
      150,
      fonts.subtitle.family,
      fonts.subtitle.size,
      fonts.subtitle.lineHeight,
      colors.subtitle,
      1
    );
  }

  let cursorY = 206;
  if (descriptionLines.length > 0) {
    fillCanvasRoundedRect(context, padding, cursorY, contentWidth, descriptionHeight, 18, colors.panelSoft);
    drawCanvasLines(context, descriptionLines, padding + 28, cursorY + 52, fonts.body.family, fonts.body.size, fonts.body.lineHeight, colors.text);
    cursorY += descriptionHeight + 24;
  }

  for (const row of rows) {
    fillCanvasRoundedRect(context, padding, cursorY, contentWidth, row.height, 18, colors.panel);
    context.fillStyle = accentColor;
    context.fillRect(padding, cursorY + 8, 10, row.height - 16);
    drawCanvasLines(context, row.labelLines, padding + 28, cursorY + 46, fonts.label.family, fonts.label.size, fonts.label.lineHeight, colors.label);
    const valueY = cursorY + 46 + (row.labelLines.length * fonts.label.lineHeight) + 22;
    drawCanvasLines(context, row.valueLines, padding + 28, valueY, fonts.body.family, fonts.body.size, fonts.body.lineHeight, colors.text);
    cursorY += row.height + 22;
  }

  const footerY = height - 34;
  const footerLeft = card.footerLeft || card.footer || new Date().toLocaleString('en-GB');
  const footerRight = card.footerRight || null;
  setCanvasFont(context, fonts.footer.family, fonts.footer.size);
  context.fillStyle = colors.muted;
  if (footerLeft) {
    context.fillText(cardText(footerLeft), padding, footerY);
  }

  if (footerRight) {
    const footerRightText = cardText(footerRight);
    const footerRightWidth = measureCanvasText(context, footerRightText, fonts.footer.family, fonts.footer.size);
    context.fillText(footerRightText, width - padding - footerRightWidth, footerY);
  }

  return encodePureImagePng(pureImage, image);
}

async function createPureImageHelpAttachment(card, slug = 'help') {
  const image = await renderPureImageHelpCard(card);
  if (!image) {
    return null;
  }

  const safeSlug = slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'help';
  return new AttachmentBuilder(image, {
    name: `${safeSlug}-${Date.now()}.png`,
  });
}

function createCardAttachment(card, slug = 'voice-room-bot') {
  const safeSlug = slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'voice-room-bot';
  return new AttachmentBuilder(renderCardImage(card) || createBotCardImage(card), {
    name: `${safeSlug}-${Date.now()}.png`,
  });
}

function createReadableCardAttachment(card, slug = 'voice-room-bot') {
  const image = renderCardImage(card);
  if (!image) {
    return null;
  }

  const safeSlug = slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'voice-room-bot';
  return new AttachmentBuilder(image, {
    name: `${safeSlug}-${Date.now()}.png`,
  });
}

function buildStatusCard(title, message, options = {}) {
  const color = options.color || (options.type === 'error'
    ? [237, 66, 69, 255]
    : options.type === 'success'
      ? [87, 242, 135, 255]
      : options.type === 'warning'
        ? [254, 231, 92, 255]
        : cardTheme.accent);

  return createCardAttachment({
    badge: options.badge || 'BOT',
    title,
    description: message,
    fields: options.fields || [],
    footer: options.footer || null,
    color,
  }, options.slug || 'status');
}

async function sendModeratorAuditLog(guild, auditEntry) {
  if (!guild || !auditEntry?.moderator || !auditEntry?.action) {
    return;
  }

  recordModeratorAuditHistory(guild, auditEntry);

  const settings = getVoiceLogSettings(guild.id);
  if (!settings.enabled || !settings.channelId) {
    return;
  }

  const logChannel =
    guild.channels.cache.get(settings.channelId) ||
    await guild.channels.fetch(settings.channelId).catch(() => null);

  if (!logChannel || logChannel.type !== ChannelType.GuildText) {
    console.warn(`Moderator audit logging is enabled for ${guild.name}, but the saved log channel could not be found.`);
    return;
  }

  const moderator = auditEntry.moderator;
  const voiceChannel = auditEntry.voiceChannel || null;
  const fields = [
    {
      name: 'Moderator',
      value: `${moderator} (${moderator.user.tag})`,
      inline: false,
    },
  ];

  if (voiceChannel) {
    fields.push({
      name: 'Room',
      value: `${voiceChannel} (${voiceChannel.name})`,
      inline: false,
    });
  }

  for (const detail of auditEntry.details || []) {
    if (!detail?.name || !detail?.value) {
      continue;
    }

    fields.push({
      name: detail.name,
      value: truncateFieldValue(String(detail.value), 1024),
      inline: Boolean(detail.inline),
    });
  }

  const auditCard = {
    badge: 'MR',
    title: 'Moderator Room Action',
    subtitle: auditEntry.action,
    fields: fields.slice(0, 10),
    footer: `Moderator ID: ${moderator.id}`,
  };
  const auditImage = renderCardImage(auditCard) || createModeratorAuditImage(auditEntry, fields.slice(0, 10));
  const attachment = new AttachmentBuilder(auditImage, {
    name: `moderator-audit-${Date.now()}.png`,
  });

  await logChannel.send({ files: [attachment] }).catch((error) => {
    console.warn(`Could not send moderator audit image in ${guild.name}:`, error);
  });
}

function formatPermissionNames(permissionNames) {
  return permissionNames.map((permissionName) => permissionName.replace(/([a-z])([A-Z])/g, '$1 $2')).join(', ');
}

function missingPermissionsFor(channel, botMember, permissionNames) {
  const permissions = channel?.permissionsFor(botMember);
  if (!permissions) {
    return permissionNames;
  }

  return permissionNames.filter((permissionName) => !permissions.has(PermissionFlagsBits[permissionName]));
}

function buildSetupCheckCard(guild, botMember) {
  const categories = getConfiguredCategories(guild.id);
  if (categories.length === 0) {
    return createCardAttachment({
      badge: 'CHK',
      title: 'Setup Health Check',
      description: 'No saved setups found. Run /setup to create one.',
      color: [237, 66, 69, 255],
    }, 'setup-check');
  }

  let issueCount = 0;
  let warningCount = 0;

  const fields = categories.slice(0, 25).map((category) => {
    const lines = [];
    const requestChannel = guild.channels.cache.get(category.requestChannelId);
    const activeCategory = guild.channels.cache.get(category.activeCategoryId);
    const archiveCategory = guild.channels.cache.get(category.archiveCategoryId);

    if (!requestChannel || requestChannel.type !== ChannelType.GuildVoice) {
      lines.push('Issue: request voice channel is missing or is not a voice channel.');
      issueCount += 1;
    }

    if (!activeCategory || activeCategory.type !== ChannelType.GuildCategory) {
      lines.push('Issue: active category is missing or is not a category.');
      issueCount += 1;
    }

    if (!archiveCategory || archiveCategory.type !== ChannelType.GuildCategory) {
      lines.push('Issue: archive category is missing or is not a category.');
      issueCount += 1;
    }

    if (requestChannel && requestChannel.type === ChannelType.GuildVoice) {
      const missingRequestPermissions = missingPermissionsFor(requestChannel, botMember, ['ViewChannel', 'Connect', 'MoveMembers']);
      if (missingRequestPermissions.length > 0) {
        lines.push(`Issue: missing ${formatPermissionNames(missingRequestPermissions)} in ${requestChannel}.`);
        issueCount += 1;
      }
    }

    if (activeCategory && activeCategory.type === ChannelType.GuildCategory) {
      const missingActivePermissions = missingPermissionsFor(activeCategory, botMember, [
        'ViewChannel',
        'ManageChannels',
        'MoveMembers',
        'Connect',
        'SendMessages',
        'AttachFiles',
      ]);
      if (missingActivePermissions.length > 0) {
        lines.push(`Issue: missing ${formatPermissionNames(missingActivePermissions)} in ${activeCategory.name}.`);
        issueCount += 1;
      }
    }

    if (archiveCategory && archiveCategory.type === ChannelType.GuildCategory) {
      const missingArchivePermissions = missingPermissionsFor(archiveCategory, botMember, ['ViewChannel', 'ManageChannels']);
      if (missingArchivePermissions.length > 0) {
        lines.push(`Issue: missing ${formatPermissionNames(missingArchivePermissions)} in ${archiveCategory.name}.`);
        issueCount += 1;
      }

      const { archiveChannels, availableChannels, totalManagedChannels } = getSetupPoolCounts(category, guild);
      const autoCreateStatus = category.autoCreateArchiveRooms
        ? `Auto-create: enabled, ${totalManagedChannels}/${category.maxArchiveRooms} managed rooms.`
        : 'Auto-create: disabled.';
      lines.push(autoCreateStatus);

      if (archiveChannels.size === 0) {
        if (category.autoCreateArchiveRooms && totalManagedChannels < category.maxArchiveRooms) {
          lines.push('Warning: archive category has no spare rooms yet, but auto-create can create one on demand.');
          warningCount += 1;
        } else {
          lines.push('Issue: archive category has no voice channels.');
          issueCount += 1;
        }
      } else if (availableChannels.size === 0) {
        if (category.autoCreateArchiveRooms && totalManagedChannels < category.maxArchiveRooms) {
          lines.push(`Archive pool: 0/${archiveChannels.size} available, but auto-create can add another room.`);
        } else {
          lines.push(`Warning: archive pool has 0/${archiveChannels.size} available voice rooms.`);
          warningCount += 1;
        }
      } else {
        lines.push(`Archive pool: ${availableChannels.size}/${archiveChannels.size} rooms available.`);
      }

      const archiveChannelPermissionIssues = archiveChannels
        .map((channel) => ({
          channel,
          missing: missingPermissionsFor(channel, botMember, ['ViewChannel', 'ManageChannels', 'MoveMembers', 'Connect', 'AttachFiles']),
        }))
        .filter((entry) => entry.missing.length > 0)
        .slice(0, 3);

      if (archiveChannelPermissionIssues.length > 0) {
        lines.push(
          `Issue: ${archiveChannelPermissionIssues
            .map((entry) => `${entry.channel.name} missing ${formatPermissionNames(entry.missing)}`)
            .join('; ')}.`
        );
        issueCount += archiveChannelPermissionIssues.length;
      }
    }

    if (activeCategory?.id && archiveCategory?.id && activeCategory.id === archiveCategory.id) {
      lines.push('Issue: active and archive categories are the same.');
      issueCount += 1;
    }

    if (lines.length === 0) {
      lines.push('Healthy: channels exist, permissions look usable, and archive rooms are available.');
    }

    return {
      name: category.name,
      value: truncateFieldValue(lines.join('\n')),
    };
  });

  const color = issueCount > 0 ? [237, 66, 69, 255] : warningCount > 0 ? [254, 231, 92, 255] : [87, 242, 135, 255];
  return createCardAttachment({
    badge: 'CHK',
    title: 'Setup Health Check',
    description: `${categories.length} setup(s) checked. ${issueCount} issue(s), ${warningCount} warning(s).`,
    fields,
    color,
  }, 'setup-check');
}

async function handleSetupCheckCommand(interaction) {
  if (!interaction.guild) {
    await interaction.reply({ files: [buildStatusCard('Setup Health Check', 'Run this command inside a server.', { type: 'error', badge: 'ERR' })] });
    return;
  }

  if (!canManageSetup(interaction)) {
    await interaction.reply({ files: [buildStatusCard('Setup Health Check', 'You need Manage Server, Manage Channels, the configured access role, or bot owner access to check setup health.', { type: 'error', badge: 'ERR' })] });
    return;
  }

  await interaction.deferReply();
  await interaction.guild.channels.fetch();
  const botMember = interaction.guild.members.me || await interaction.guild.members.fetchMe().catch(() => null);

  if (!botMember) {
    await interaction.editReply({ attachments: [], files: [buildStatusCard('Setup Health Check', 'I could not check my server permissions right now.', { type: 'error', badge: 'ERR' })] });
    return;
  }

  await interaction.editReply({
    attachments: [],
    files: [buildSetupCheckCard(interaction.guild, botMember)],
  });
}

async function handleSetupAutoCreateCommand(interaction) {
  if (!interaction.guild) {
    await interaction.reply({ files: [buildStatusCard('Auto-create Setup', 'Run this command inside a server.', { type: 'error', badge: 'ERR' })] });
    return;
  }

  if (!canManageSetup(interaction)) {
    await interaction.reply({ files: [buildStatusCard('Auto-create Setup', 'You need Manage Server, Manage Channels, the configured access role, or bot owner access to change auto-create settings.', { type: 'error', badge: 'ERR' })] });
    return;
  }

  const requestChannel = interaction.options.getChannel('request-channel');
  if (!requestChannel || requestChannel.type !== ChannelType.GuildVoice) {
    await interaction.reply({ files: [buildStatusCard('Auto-create Setup', 'Choose the request voice channel for an existing setup.', { type: 'error', badge: 'ERR' })] });
    return;
  }

  const enabled = interaction.options.getBoolean('enabled');
  const requestedMaxRooms = interaction.options.getInteger('max-rooms');
  const existingCategory = getConfiguredCategories(interaction.guild.id).find(
    (category) => category.requestChannelId === requestChannel.id
  );

  if (!existingCategory) {
    await interaction.reply({ files: [buildStatusCard('Auto-create Setup', 'I could not find a saved setup for that request channel. Run /setup first.', { type: 'error', badge: 'ERR' })] });
    return;
  }

  const maxArchiveRooms = requestedMaxRooms || existingCategory.maxArchiveRooms || 10;
  const updatedCategory = updateAutoCreateSettings(
    interaction.guild.id,
    requestChannel.id,
    enabled,
    maxArchiveRooms
  );

  if (!updatedCategory) {
    await interaction.reply({ files: [buildStatusCard('Auto-create Setup', 'I could not update that setup.', { type: 'error', badge: 'ERR' })] });
    return;
  }

  await interaction.guild.channels.fetch();
  const { totalManagedChannels, availableChannels, archiveChannels } = getSetupPoolCounts(updatedCategory, interaction.guild);

  await interaction.reply({
    files: [buildStatusCard('Auto-create Setup', `Auto-create is now ${updatedCategory.autoCreateArchiveRooms ? 'enabled' : 'disabled'} for ${updatedCategory.name}.`, {
      type: 'success',
      badge: 'SET',
      fields: [
        { name: 'Limit', value: `${updatedCategory.maxArchiveRooms} managed room(s).` },
        { name: 'Current pool', value: `${availableChannels.size}/${archiveChannels.size} archived rooms available, ${totalManagedChannels} managed total.` },
      ],
    })],
  });
}

function isCurrentRoomOwner(member) {
  const memberVoiceChannel = member?.voice?.channel;
  if (!memberVoiceChannel) {
    return false;
  }

  return voiceChannelOwners.get(memberVoiceChannel.id) === member.id;
}

const helpPageOrder = ['general', 'xp', 'logging', 'moderator', 'setup'];
const helpPages = {
  general: {
    title: 'General',
    description: 'Everyday room commands and owner tools.',
  },
  xp: {
    title: 'XP',
    description: 'XP profiles and leaderboards.',
  },
  logging: {
    title: 'Logging',
    description: 'Voice and moderator audit logging.',
  },
  moderator: {
    title: 'Moderator Room Controls',
    description: 'Moderator controls for managed rooms.',
  },
  setup: {
    title: 'Setup',
    description: 'Server setup commands for voice-room pools.',
  },
};

function getHelpPage(page) {
  return helpPages[page] ? page : 'general';
}

function buildHelpMenu(userId, selectedPage = 'general') {
  const activePage = getHelpPage(selectedPage);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`help-page:${userId}`)
    .setPlaceholder('Choose a help page')
    .addOptions(helpPageOrder.map((page) => ({
      label: helpPages[page].title,
      value: page,
      description: helpPages[page].description,
      default: page === activePage,
    })));

  return new ActionRowBuilder().addComponents(menu);
}

function formatHelpRequester(interaction) {
  return interaction.member?.displayName ||
    interaction.user?.globalName ||
    interaction.user?.username ||
    interaction.user?.tag ||
    'Unknown user';
}

function buildHelpCard(interaction, page = 'general') {
  const activePage = getHelpPage(page);
  const canRunSetup = canManageSetup(interaction);
  const canConfigureRole = canConfigureAccessRole(interaction);
  const canRunLogs = canManageLogs(interaction);
  const canRunTopHosts = canViewTopHosts(interaction);
  const canRunXpRoles = canManageXpRoles(interaction);
  const canRunModeratorOverride = canUseModeratorOverride(interaction);
  const fields = [];
  const notes = [];

  if (activePage === 'general') {
    fields.push(
      {
        name: '/help',
        value: 'Shows this command guide.',
      },
      {
        name: '/rooms',
        value: 'Shows active voice rooms, owners, user counts, and available archived rooms.',
      },
      {
        name: '/userlimit',
        value: 'Posts the user-limit selector for your active room. Requires you to own a bot-managed active room.',
      },
      {
        name: '/transfer member:@user',
        value: 'Transfers ownership of your active room to another member in the same voice room. Requires you to own that room.',
      },
      {
        name: '/rename name:Room name',
        value: 'Renames your active voice room until it returns to the archive pool. Requires you to own that room.',
      }
    );
  }

  if (activePage === 'xp') {
    fields.push(
      {
        name: '/hostprofile member:@user',
        value: 'Shows host XP, rank, hosted time, and room streaks.',
      },
      {
        name: '/vcprofile member:@user',
        value: 'Shows regular voice member XP, rank, voice time, and streaks.',
      },
      {
        name: '/topmembers limit:10',
        value: 'Shows the regular voice member XP leaderboard.',
      }
    );

    if (canRunTopHosts) {
      fields.push({
        name: '/tophosts limit:10',
        value: 'Shows the top managed voice room hosts by host XP, hosted time, and streaks.',
      });
    } else {
      notes.push('Top hosts requires Manage Server, Manage Channels, the configured access role, or bot owner access.');
    }

    if (canRunXpRoles) {
      fields.push({
        name: '/xp-roles member:@user',
        value: 'Syncs Discord roles named after the current host and voice XP ranks.',
      });
    } else {
      notes.push('XP role sync requires Manage Server, Manage Channels, the configured access role, or bot owner access.');
    }
  }

  if (activePage === 'logging') {
    if (canRunLogs) {
      fields.push({
        name: '/logs channel:#logs enabled:true',
        value: 'Sets, checks, enables, or disables voice activity and moderator audit logging.',
      });
    } else {
      notes.push('Logging requires Manage Server, Manage Channels, Moderate Members, the configured access role, or bot owner access.');
    }
  }

  if (activePage === 'moderator') {
    if (canRunModeratorOverride) {
      fields.push(
        {
          name: '/mr help',
          value: 'Shows the moderator room command menu.',
        },
        {
          name: '/mr transfer channel:#room member:@user',
          value: 'Transfers ownership of a managed active room to a member already inside that room.',
        },
        {
          name: '/mr rename channel:#room name:Room name',
          value: 'Renames a managed room. The original archive name is restored when the room returns to archive.',
        },
        {
          name: '/mr userlimit channel:#room limit:0-99',
          value: 'Changes the room user limit. Use 0 for unlimited.',
        },
        {
          name: '/mr lock channel:#room',
          value: 'Stops new users from joining while allowing current members to stay.',
        },
        {
          name: '/mr unlock channel:#room',
          value: 'Restores the room permissions saved before it was locked.',
        },
        {
          name: '/mr close channel:#room',
          value: 'Returns an empty managed room to the archive category.',
        },
        {
          name: '/mr history channel:#room',
          value: 'Shows recent moderator actions and notes for managed rooms.',
        },
        {
          name: '/mr note channel:#room note:text',
          value: 'Saves a moderator note on a managed active room.',
        }
      );
    } else {
      notes.push('Moderator controls require Manage Server, Manage Channels, Moderate Members, the configured access role, or bot owner access.');
    }
  }

  if (activePage === 'setup') {
    if (canRunSetup) {
      fields.push(
        {
          name: '/setup',
          value: 'Opens menus to choose a request voice channel, active category, and archive category.',
        },
        {
          name: '/setup-list',
          value: 'Shows saved voice-room setups for this server.',
        },
        {
          name: '/setup-check',
          value: 'Checks saved setups for missing channels, empty archive pools, and bot permission problems.',
        },
        {
          name: '/setup-autocreate request-channel enabled max-rooms',
          value: 'Enables or disables automatic archive room creation for a setup.',
        },
        {
          name: '/setup-remove',
          value: 'Removes a saved voice-room setup.',
        }
      );

      if (canConfigureRole) {
        fields.push({
          name: '/access-role role:@Role',
          value: 'Sets the role that can use bot admin and moderator commands. Use clear:true to remove it.',
        });
      }
    } else {
      notes.push('Setup commands require Manage Server, Manage Channels, the configured access role, or bot owner access.');
    }
  }

  if (fields.length === 0) {
    fields.push({
      name: 'No commands available',
      value: notes.length > 0
        ? [...new Set(notes)].join('\n')
        : 'You do not have access to commands on this page.',
    });
  }

  return {
    badge: 'HLP',
    title: helpPages[activePage].title,
    subtitle: 'Voice Room Bot Help',
    description: null,
    fields,
    footer: null,
    timestampPlacement: 'footer',
    footerRight: `Requested by ${formatHelpRequester(interaction)}`,
  };
}

function getHelpFooterLeft() {
  return new Date().toLocaleString('en-GB');
}

async function buildHelpMessagePayload(interaction, page = 'general') {
  const activePage = getHelpPage(page);
  const card = buildHelpCard(interaction, activePage);
  const helpCard = {
    ...card,
    footerLeft: getHelpFooterLeft(),
    footerRight: `Requested by ${formatHelpRequester(interaction)}`,
    timestampPlacement: 'footer',
  };
  const attachment = createReadableCardAttachment(helpCard, `help-${activePage}`) ||
    await createPureImageHelpAttachment(helpCard, `help-${activePage}`) ||
    createCardAttachment(helpCard, `help-${activePage}`);

  return {
    files: [attachment],
    embeds: [],
  };
}

async function handleHelpCommand(interaction) {
  if (!interaction.guild) {
    await interaction.reply({ files: [buildStatusCard('Help', 'Run this command inside a server.', { type: 'error', badge: 'ERR' })] });
    return;
  }

  await interaction.deferReply();
  const helpPayload = await buildHelpMessagePayload(interaction, 'general');
  await interaction.editReply({
    ...helpPayload,
    components: [buildHelpMenu(interaction.user.id, 'general')],
  });
}

async function handleHelpPageSelect(interaction) {
  const [, ownerId] = interaction.customId.split(':');

  if (interaction.user.id !== ownerId) {
    await interaction.deferReply({ ephemeral: true });
    await interaction.editReply({
      files: [buildStatusCard('Help', 'Only the user who opened this help menu can change pages.', { type: 'error', badge: 'ERR' })],
    });
    return;
  }

  if (!interaction.guild) {
    await interaction.deferReply({ ephemeral: true });
    await interaction.editReply({
      files: [buildStatusCard('Help', 'Run this command inside a server.', { type: 'error', badge: 'ERR' })],
    });
    return;
  }

  const page = getHelpPage(interaction.values[0]);
  await interaction.deferUpdate();
  const helpPayload = await buildHelpMessagePayload(interaction, page);
  await interaction.editReply({
    attachments: [],
    ...helpPayload,
    components: [buildHelpMenu(ownerId, page)],
  });
}

async function handleRoomsCommand(interaction) {
  if (!interaction.guild) {
    await interaction.reply({ files: [buildStatusCard('Voice Rooms', 'Run this command inside a server.', { type: 'error', badge: 'ERR' })] });
    return;
  }

  await interaction.deferReply();
  await interaction.guild.channels.fetch();

  await interaction.editReply({
    attachments: [],
    files: [buildRoomsCard(interaction.guild)],
  });
}

async function handleTopHostsCommand(interaction) {
  if (!interaction.guild) {
    await interaction.reply({ files: [buildStatusCard('Top Hosts', 'Run this command inside a server.', { type: 'error', badge: 'ERR' })] });
    return;
  }

  if (!canViewTopHosts(interaction)) {
    await interaction.reply({
      files: [buildStatusCard('Top Hosts', 'You need Manage Server, Manage Channels, the configured access role, or bot owner access to view top voice room hosts.', { type: 'error', badge: 'ERR' })],
    });
    return;
  }

  const requestedLimit = interaction.options.getInteger('limit') || 10;
  const limit = Math.min(Math.max(requestedLimit, 1), 25);
  await interaction.deferReply();

  await interaction.editReply({
    attachments: [],
    files: [await buildTopHostsCard(interaction.guild, limit)],
  });
}

async function handleHostProfileCommand(interaction) {
  if (!interaction.guild) {
    await interaction.reply({ files: [buildStatusCard('Host Profile', 'Run this command inside a server.', { type: 'error', badge: 'ERR' })] });
    return;
  }

  const requestedUser = interaction.options.getUser('member') || interaction.user;
  await interaction.deferReply();
  await interaction.editReply({
    attachments: [],
    files: [await buildHostProfileCard(interaction.guild, requestedUser.id)],
  });
}

async function handleTopMembersCommand(interaction) {
  if (!interaction.guild) {
    await interaction.reply({ files: [buildStatusCard('Top Members', 'Run this command inside a server.', { type: 'error', badge: 'ERR' })] });
    return;
  }

  const requestedLimit = interaction.options.getInteger('limit') || 10;
  const limit = Math.min(Math.max(requestedLimit, 1), 25);
  await interaction.deferReply();

  await interaction.editReply({
    attachments: [],
    files: [await buildTopMembersCard(interaction.guild, limit)],
  });
}

async function handleVoiceProfileCommand(interaction) {
  if (!interaction.guild) {
    await interaction.reply({ files: [buildStatusCard('Voice Member Profile', 'Run this command inside a server.', { type: 'error', badge: 'ERR' })] });
    return;
  }

  const requestedUser = interaction.options.getUser('member') || interaction.user;
  await interaction.deferReply();
  await interaction.editReply({
    attachments: [],
    files: [await buildVoiceProfileCard(interaction.guild, requestedUser.id)],
  });
}

function formatSetPreview(values, emptyText) {
  const list = [...values].filter(Boolean);
  if (list.length === 0) {
    return emptyText;
  }

  return truncateFieldValue(list.slice(0, 10).join('\n'));
}

function buildXpRolesSyncCard(summary, options = {}) {
  const fields = [
    {
      name: 'Scope',
      value: options.member
        ? `${options.member} (${options.member.user.tag})`
        : `${summary.memberCount} known XP member(s) checked`,
      inline: false,
    },
    {
      name: 'Updated',
      value: [
        `${summary.assigned} current rank role(s) added`,
        `${summary.removed} old rank role(s) removed`,
        `${summary.trackCount} XP track(s) checked`,
      ].join('\n'),
      inline: false,
    },
  ];

  if (summary.missingRoles.size > 0) {
    fields.push({
      name: 'Missing Discord Roles',
      value: formatSetPreview(summary.missingRoles, 'None'),
      inline: false,
    });
  }

  if (summary.blockedRoles.size > 0) {
    fields.push({
      name: 'Roles I Could Not Manage',
      value: formatSetPreview(summary.blockedRoles, 'None'),
      inline: false,
    });
  }

  if (summary.noStats > 0 || summary.missingMembers > 0) {
    fields.push({
      name: 'Skipped',
      value: [
        summary.noStats > 0 ? `${summary.noStats} XP track(s) had no stored stats` : null,
        summary.missingMembers > 0 ? `${summary.missingMembers} saved member(s) could not be fetched` : null,
      ].filter(Boolean).join('\n'),
      inline: false,
    });
  }

  return createCardAttachment({
    badge: 'XP',
    title: 'XP Rank Roles Synced',
    description: 'Rank roles use the existing XP rank names. Create Discord roles with those exact names to enable rewards.',
    fields,
    footer: 'The bot needs Manage Roles and its highest role must be above the XP rank roles.',
  }, 'xp-roles');
}

async function handleXpRolesCommand(interaction) {
  if (!interaction.guild) {
    await interaction.reply({ files: [buildStatusCard('XP Rank Roles', 'Run this command inside a server.', { type: 'error', badge: 'ERR' })] });
    return;
  }

  if (!canManageXpRoles(interaction)) {
    await interaction.reply({
      files: [buildStatusCard('XP Rank Roles', 'You need Manage Server, Manage Channels, the configured access role, or bot owner access to sync XP rank roles.', { type: 'error', badge: 'ERR' })],
    });
    return;
  }

  const requestedUser = interaction.options.getUser('member');
  await interaction.deferReply();

  const requestedMember = requestedUser
    ? await fetchGuildMember(interaction.guild, requestedUser.id)
    : null;

  if (requestedUser && !requestedMember) {
    await interaction.editReply({
      attachments: [],
      files: [buildStatusCard('XP Rank Roles', 'I could not find that member in this server.', { type: 'error', badge: 'ERR' })],
    });
    return;
  }

  const summary = await syncKnownXpRankRoles(interaction.guild, requestedMember);
  await interaction.editReply({
    attachments: [],
    files: [buildXpRolesSyncCard(summary, { member: requestedMember })],
  });
}

async function handleAccessRoleCommand(interaction) {
  if (!interaction.guild) {
    await interaction.reply({ files: [buildStatusCard('Access Role', 'Run this command inside a server.', { type: 'error', badge: 'ERR' })] });
    return;
  }

  if (!canConfigureAccessRole(interaction)) {
    await interaction.reply({
      files: [buildStatusCard('Access Role', 'You need Manage Server, Manage Channels, or bot owner access to change the bot access role.', { type: 'error', badge: 'ERR' })],
    });
    return;
  }

  const requestedRole = interaction.options.getRole('role');
  const shouldClear = interaction.options.getBoolean('clear') === true;
  const currentRoleId = getCommandAccessRoleId(interaction.guild.id);

  if (requestedRole && shouldClear) {
    await interaction.reply({
      files: [buildStatusCard('Access Role', 'Choose a role or use clear:true, not both.', { type: 'error', badge: 'ERR' })],
    });
    return;
  }

  if (shouldClear) {
    saveCommandAccessRole(interaction.guild.id, null, interaction.user.id);
    await interaction.reply({
      files: [buildStatusCard('Access Role', 'Cleared the bot access role. Built-in Discord permissions are now required again.', { type: 'success', badge: 'ROLE' })],
    });
    return;
  }

  if (requestedRole) {
    if (requestedRole.id === interaction.guild.id) {
      await interaction.reply({
        files: [buildStatusCard('Access Role', 'Choose a specific role, not @everyone.', { type: 'error', badge: 'ERR' })],
      });
      return;
    }

    saveCommandAccessRole(interaction.guild.id, requestedRole.id, interaction.user.id);
    await interaction.reply({
      files: [buildStatusCard('Access Role', `${requestedRole} can now use bot admin and moderator commands.`, { type: 'success', badge: 'ROLE' })],
    });
    return;
  }

  await interaction.reply({
    files: [buildStatusCard('Access Role', currentRoleId
      ? `Current bot access role: <@&${currentRoleId}>.`
      : 'No bot access role is configured yet.', {
      badge: 'ROLE',
    })],
  });
}

async function getVoiceLogChannel(guild, channelId) {
  if (!channelId) {
    return null;
  }

  return guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
}

function formatVoiceLogStatus(settings) {
  if (settings.enabled && settings.channelId) {
    return `Voice activity and moderator audit logging are enabled in <#${settings.channelId}>.`;
  }

  if (settings.channelId) {
    return `Voice activity and moderator audit logging are disabled. Saved log channel: <#${settings.channelId}>.`;
  }

  return 'Logging is not configured yet. Use `/logs channel:#channel` to choose a text channel.';
}

async function handleLogsCommand(interaction) {
  if (!interaction.guild) {
    await interaction.reply({ files: [buildStatusCard('Logging', 'Run this command inside a server.', { type: 'error', badge: 'ERR' })] });
    return;
  }

  if (!canManageLogs(interaction)) {
    await interaction.reply({
      files: [buildStatusCard('Logging', 'You need Manage Server, Manage Channels, Moderate Members, the configured access role, or bot owner access to change voice logs.', { type: 'error', badge: 'ERR' })],
    });
    return;
  }

  const requestedChannel = interaction.options.getChannel('channel');
  const requestedEnabled = interaction.options.getBoolean('enabled');
  const currentSettings = getVoiceLogSettings(interaction.guild.id);

  if (!requestedChannel && requestedEnabled === null) {
    await interaction.reply({ files: [buildStatusCard('Logging', formatVoiceLogStatus(currentSettings), { badge: 'LOG' })] });
    return;
  }

  if (requestedChannel && requestedChannel.type !== ChannelType.GuildText) {
    await interaction.reply({ files: [buildStatusCard('Logging', 'Choose a normal text channel for voice logs.', { type: 'error', badge: 'ERR' })] });
    return;
  }

  const nextChannelId = requestedChannel?.id || currentSettings.channelId;
  const nextEnabled = requestedEnabled === null ? Boolean(requestedChannel || currentSettings.enabled) : requestedEnabled;

  if (nextEnabled && !nextChannelId) {
    await interaction.reply({ files: [buildStatusCard('Logging', 'Choose a text channel before enabling voice logs.', { type: 'error', badge: 'ERR' })] });
    return;
  }

  const logChannel = nextEnabled ? await getVoiceLogChannel(interaction.guild, nextChannelId) : requestedChannel;
  if (nextEnabled && (!logChannel || logChannel.type !== ChannelType.GuildText)) {
    await interaction.reply({ files: [buildStatusCard('Logging', 'I could not find that saved log channel. Choose a text channel with /logs channel:#channel.', { type: 'error', badge: 'ERR' })] });
    return;
  }

  if (nextEnabled) {
    const botMember = interaction.guild.members.me || await interaction.guild.members.fetchMe().catch(() => null);
    if (!botMember) {
      await interaction.reply({ files: [buildStatusCard('Logging', 'I could not check my permissions for that log channel right now.', { type: 'error', badge: 'ERR' })] });
      return;
    }

    const missingPermissions = missingPermissionsFor(logChannel, botMember, voiceLogPermissionNames);
    if (missingPermissions.length > 0) {
      await interaction.reply({
        files: [buildStatusCard('Logging', `I need ${formatPermissionNames(missingPermissions)} in ${logChannel} before I can send logs there.`, { type: 'error', badge: 'ERR' })],
      });
      return;
    }
  }

  const updatedSettings = saveVoiceLogSettings(interaction.guild.id, {
    channelId: nextChannelId,
    enabled: nextEnabled,
    updatedBy: interaction.user.id,
  });

  await interaction.reply({
    files: [buildStatusCard('Logging', nextEnabled
      ? `Voice activity and moderator audit logging are now enabled in <#${updatedSettings.channelId}>.`
      : formatVoiceLogStatus(updatedSettings), {
      type: nextEnabled ? 'success' : 'warning',
      badge: 'LOG',
    })],
  });
}

function validateManagedVoiceRoom(guild, voiceChannel) {
  if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
    return { ok: false, message: 'Choose a bot-managed active voice room.' };
  }

  const savedChannel = botState.activeChannels[voiceChannel.id];
  if (!savedChannel || savedChannel.guildId !== guild.id) {
    return { ok: false, message: 'That voice channel is not an active room managed by this bot.' };
  }

  const ownerId = voiceChannelOwners.get(voiceChannel.id) || savedChannel.ownerId;
  if (!ownerId) {
    return { ok: false, message: 'That room is missing an owner. Wait for the bot to reassign one, then try again.' };
  }

  return { ok: true, voiceChannel, savedChannel, ownerId };
}

function getSelectedManagedVoiceRoom(interaction) {
  return validateManagedVoiceRoom(interaction.guild, interaction.options.getChannel('channel'));
}

async function getSelectedManagedVoiceRoomById(interaction, channelId) {
  if (!isDiscordId(channelId)) {
    return { ok: false, message: 'Choose one of the managed rooms shown in the channel picker.' };
  }

  const voiceChannel =
    interaction.guild.channels.cache.get(channelId) ||
    await interaction.guild.channels.fetch(channelId).catch(() => null);

  return validateManagedVoiceRoom(interaction.guild, voiceChannel);
}

async function renameManagedVoiceRoom(voiceChannel, requestedName) {
  await voiceChannel.setName(requestedName);
  const savedChannel = botState.activeChannels[voiceChannel.id];
  if (savedChannel) {
    savedChannel.channelName = requestedName;
    savedChannel.updatedAt = new Date().toISOString();
    saveState();
  }
}

async function setManagedVoiceRoomLock(voiceChannel, moderatorMember, locked) {
  const savedChannel = botState.activeChannels[voiceChannel.id];
  if (!savedChannel) {
    return { ok: false, message: 'That voice channel is not an active room managed by this bot.' };
  }

  if (locked) {
    if (savedChannel.moderatorLocked) {
      return { ok: true, message: `${voiceChannel} is already locked.` };
    }

    const activePermissionSnapshot =
      savedChannel.moderatorLockPermissionOverwrites || capturePermissionOverwrites(voiceChannel);

    await voiceChannel.permissionOverwrites.edit(
      voiceChannel.guild.roles.everyone,
      { Connect: false },
      { reason: `Room locked by ${moderatorMember.user.tag}` }
    );

    savedChannel.moderatorLocked = true;
    savedChannel.moderatorLockedBy = moderatorMember.id;
    savedChannel.moderatorLockedAt = new Date().toISOString();
    savedChannel.moderatorLockPermissionOverwrites = activePermissionSnapshot;
    savedChannel.updatedAt = new Date().toISOString();
    saveState();

    return { ok: true, message: `${voiceChannel} is now locked. Current members can stay, but new users cannot join.` };
  }

  if (!savedChannel.moderatorLocked && !savedChannel.moderatorLockPermissionOverwrites) {
    return { ok: true, message: `${voiceChannel} is already unlocked.` };
  }

  if (savedChannel.moderatorLockPermissionOverwrites) {
    await restorePermissionOverwrites(voiceChannel, savedChannel.moderatorLockPermissionOverwrites);
  } else {
    await voiceChannel.permissionOverwrites.edit(
      voiceChannel.guild.roles.everyone,
      { Connect: null },
      { reason: `Room unlocked by ${moderatorMember.user.tag}` }
    );
  }

  savedChannel.moderatorLocked = false;
  savedChannel.moderatorLockedBy = null;
  savedChannel.moderatorLockedAt = null;
  savedChannel.moderatorLockPermissionOverwrites = null;
  savedChannel.updatedAt = new Date().toISOString();
  saveState();

  return { ok: true, message: `${voiceChannel} is now unlocked.` };
}

async function closeManagedVoiceRoom(voiceChannel) {
  const savedChannel = botState.activeChannels[voiceChannel.id];
  if (!savedChannel) {
    return { ok: false, message: 'That voice channel is not an active room managed by this bot.' };
  }

  if (voiceChannel.members.size > 0) {
    return { ok: false, message: `${voiceChannel} must be empty before it can be returned to archive.` };
  }

  const archiveCategoryId = savedChannel.archiveCategoryId || poolChannelArchive.get(voiceChannel.id)?.archiveCategoryId;
  if (!archiveCategoryId) {
    return { ok: false, message: 'I could not find the archive category for that room.' };
  }

  await moveChannelToCategory(voiceChannel, archiveCategoryId);
  const savedPermissions = voiceChannelPermissionSnapshots.get(voiceChannel.id) || savedChannel.permissionOverwrites;
  if (savedPermissions) {
    await restorePermissionOverwrites(voiceChannel, savedPermissions);
  }
  await restoreOriginalChannelName(voiceChannel);
  forgetActiveChannel(voiceChannel.id);

  return { ok: true, message: `${voiceChannel} has been returned to the archive.` };
}

function buildModRoomHelpCard() {
  return createCardAttachment({
    badge: 'MR',
    title: '/mr Moderator Room Commands',
    description: 'Moderator overrides only work on active voice rooms currently managed by this bot.',
    fields: [
      {
        name: '/mr help',
        value: 'Shows this moderator room command menu.',
      },
      {
        name: '/mr transfer channel:#room member:@user',
        value: 'Transfers ownership of a managed active room to a member already inside that room. The channel field only suggests rooms created from the archive pool.',
      },
      {
        name: '/mr rename channel:#room name:Room name',
        value: 'Renames a managed room. The original archive name is restored when the room returns to archive.',
      },
      {
        name: '/mr userlimit channel:#room limit:0-99',
        value: 'Changes the room user limit. Use 0 for unlimited.',
      },
      {
        name: '/mr lock channel:#room',
        value: 'Stops new users from joining while allowing current members to stay.',
      },
      {
        name: '/mr unlock channel:#room',
        value: 'Restores the room permissions saved before it was locked.',
      },
      {
        name: '/mr close channel:#room',
        value: 'Returns an empty managed room to the archive category.',
      },
      {
        name: '/mr history channel:#room',
        value: 'Shows recent moderator actions and notes. Leave channel blank to see the latest room history across the server.',
      },
      {
        name: '/mr note channel:#room note:text',
        value: 'Saves a moderator note on a managed active room and adds it to the audit history.',
      }
    ],
    footer: 'Requires Manage Server, Manage Channels, Moderate Members, the configured access role, or bot owner access. Successful actions are audited as image cards when logging is enabled.',
  }, 'mr-help');
}

function formatModeratorHistoryDate(createdAt) {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) {
    return 'Unknown time';
  }

  return date.toLocaleString('en-GB');
}

function buildModeratorRoomHistoryCard(guild, entries, options = {}) {
  const filterChannel = options.channel || null;
  const fields = entries.map((entry) => {
    const lines = [];
    if (entry.roomId || entry.roomName) {
      const room = entry.roomId ? guild.channels.cache.get(entry.roomId) : null;
      lines.push(`Room: ${room ? `${room} (${room.name})` : entry.roomName || `<#${entry.roomId}>`}`);
    }

    if (entry.moderatorId || entry.moderatorTag) {
      lines.push(`Moderator: ${entry.moderatorId ? `<@${entry.moderatorId}>` : entry.moderatorTag}`);
    }

    for (const detail of entry.details || []) {
      lines.push(`${detail.name}: ${detail.value}`);
    }

    return {
      name: `${formatModeratorHistoryDate(entry.createdAt)} - ${entry.action}`,
      value: truncateFieldValue(lines.length > 0 ? lines.join('\n') : 'No extra details saved.'),
      inline: false,
    };
  });

  if (fields.length === 0) {
    fields.push({
      name: 'No history yet',
      value: filterChannel
        ? `No moderator history is saved for ${filterChannel}.`
        : 'Moderator actions and notes will appear here after staff use /mr controls.',
      inline: false,
    });
  }

  return createCardAttachment({
    badge: 'HIS',
    title: 'Moderator Room History',
    description: filterChannel ? `Filtered to ${filterChannel.name}.` : 'Latest moderator room actions and notes.',
    fields,
    footer: `The bot keeps the latest ${moderatorRoomHistoryLimit} moderator room history entries per server.`,
  }, 'mr-history');
}

function normalizeModeratorNoteText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

async function handleModRoomCommand(interaction) {
  if (!interaction.guild) {
    await interaction.reply({ files: [buildStatusCard('Moderator Room Override', 'Run this command inside a server.', { type: 'error', badge: 'ERR' })] });
    return;
  }

  if (!canUseModeratorOverride(interaction)) {
    await interaction.reply({
      files: [buildStatusCard('Moderator Room Override', 'You need Manage Server, Manage Channels, Moderate Members, the configured access role, or bot owner access to use moderator room overrides.', { type: 'error', badge: 'ERR' })],
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'help') {
    await interaction.reply({ files: [buildModRoomHelpCard()] });
    return;
  }

  if (subcommand === 'history') {
    const filterChannel = interaction.options.getChannel('channel');
    if (filterChannel && filterChannel.type !== ChannelType.GuildVoice) {
      await interaction.reply({ files: [buildStatusCard('Moderator Room History', 'Choose a voice channel to filter history.', { type: 'error', badge: 'ERR' })] });
      return;
    }

    const requestedLimit = interaction.options.getInteger('limit') || moderatorRoomHistoryDisplayLimit;
    const entries = getModeratorRoomHistory(interaction.guild.id, {
      channelId: filterChannel?.id || null,
      limit: requestedLimit,
    });

    await interaction.reply({
      files: [buildModeratorRoomHistoryCard(interaction.guild, entries, { channel: filterChannel })],
    });
    return;
  }

  const selectedRoom = subcommand === 'transfer'
    ? await getSelectedManagedVoiceRoomById(interaction, interaction.options.getString('channel'))
    : getSelectedManagedVoiceRoom(interaction);
  if (!selectedRoom.ok) {
    await interaction.reply({ files: [buildStatusCard('Moderator Room Override', selectedRoom.message, { type: 'error', badge: 'ERR' })] });
    return;
  }

  const { voiceChannel, ownerId } = selectedRoom;

  await interaction.deferReply();

  try {
    if (subcommand === 'transfer') {
      const targetUser = interaction.options.getUser('member');
      const previousOwner = ownerId ? await interaction.guild.members.fetch(ownerId).catch(() => null) : null;
      const result = await transferVoiceChannelOwnership({
        guild: interaction.guild,
        voiceChannel,
        actorMember: interaction.member,
        targetUserId: targetUser?.id,
        allowOverride: true,
      });

      if (!result.ok) {
        await interaction.editReply({ attachments: [], files: [buildStatusCard('Moderator Room Override', result.message, { type: 'error', badge: 'ERR' })] });
        return;
      }

      await notifyNewOwner(voiceChannel, result.targetMember, {
        previousOwner,
        reason: 'override',
        moderator: interaction.member,
      });

      await sendModeratorAuditLog(interaction.guild, {
        action: 'Transferred room ownership',
        moderator: interaction.member,
        voiceChannel,
        details: [
          { name: 'Previous owner', value: previousOwner ? `${previousOwner} (${previousOwner.user.tag})` : `<@${ownerId}>`, inline: false },
          { name: 'New owner', value: `${result.targetMember} (${result.targetMember.user.tag})`, inline: false },
        ],
      });

      await interaction.editReply({ attachments: [], files: [buildStatusCard('Moderator Room Override', `${result.targetMember} is now the owner of ${voiceChannel}.`, { type: 'success', badge: 'MR' })] });
      return;
    }

    if (subcommand === 'rename') {
      const requestedName = normalizeRoomName(interaction.options.getString('name') || '');
      if (requestedName.length < 1 || requestedName.length > 100) {
        await interaction.editReply({ attachments: [], files: [buildStatusCard('Moderator Room Override', 'Room names must be between 1 and 100 characters.', { type: 'error', badge: 'ERR' })] });
        return;
      }

      const previousName = voiceChannel.name;
      await renameManagedVoiceRoom(voiceChannel, requestedName);
      await sendModeratorAuditLog(interaction.guild, {
        action: 'Renamed a managed room',
        moderator: interaction.member,
        voiceChannel,
        details: [
          { name: 'Previous name', value: previousName, inline: true },
          { name: 'New name', value: requestedName, inline: true },
        ],
      });
      await interaction.editReply({ attachments: [], files: [buildStatusCard('Moderator Room Override', `${voiceChannel} has been renamed to ${requestedName}.`, { type: 'success', badge: 'MR' })] });
      return;
    }

    if (subcommand === 'userlimit') {
      const selectedLimit = interaction.options.getInteger('limit');
      const previousLimit = formatUserLimit(voiceChannel);
      const updatedChannel = await voiceChannel.setUserLimit(selectedLimit);
      await sendModeratorAuditLog(interaction.guild, {
        action: 'Changed a managed room user limit',
        moderator: interaction.member,
        voiceChannel: updatedChannel,
        details: [
          { name: 'Previous limit', value: previousLimit, inline: true },
          { name: 'New limit', value: formatUserLimit(updatedChannel), inline: true },
        ],
      });
      await interaction.editReply({ attachments: [], files: [buildStatusCard('Moderator Room Override', `${updatedChannel} now has a user limit of ${formatUserLimit(updatedChannel)}.`, { type: 'success', badge: 'MR' })] });
      return;
    }

    if (subcommand === 'lock' || subcommand === 'unlock') {
      const result = await setManagedVoiceRoomLock(voiceChannel, interaction.member, subcommand === 'lock');
      await sendModeratorAuditLog(interaction.guild, {
        action: subcommand === 'lock' ? 'Locked a managed room' : 'Unlocked a managed room',
        moderator: interaction.member,
        voiceChannel,
        details: [
          { name: 'Result', value: result.message, inline: false },
        ],
      });
      await interaction.editReply({ attachments: [], files: [buildStatusCard('Moderator Room Override', result.message, { type: result.ok ? 'success' : 'warning', badge: 'MR' })] });
      return;
    }

    if (subcommand === 'close') {
      const previousName = voiceChannel.name;
      const result = await closeManagedVoiceRoom(voiceChannel);
      if (result.ok) {
        await sendModeratorAuditLog(interaction.guild, {
          action: 'Returned a managed room to archive',
          moderator: interaction.member,
          voiceChannel,
          details: [
            { name: 'Room name before close', value: previousName, inline: false },
            { name: 'Result', value: result.message, inline: false },
          ],
        });
      }
      await interaction.editReply({ attachments: [], files: [buildStatusCard('Moderator Room Override', result.message, { type: result.ok ? 'success' : 'error', badge: result.ok ? 'MR' : 'ERR' })] });
      return;
    }

    if (subcommand === 'note') {
      const note = normalizeModeratorNoteText(interaction.options.getString('note'));
      if (!note) {
        await interaction.editReply({ attachments: [], files: [buildStatusCard('Moderator Room Override', 'Write a note before saving it.', { type: 'error', badge: 'ERR' })] });
        return;
      }

      await sendModeratorAuditLog(interaction.guild, {
        type: 'note',
        action: 'Added a moderator room note',
        moderator: interaction.member,
        voiceChannel,
        details: [
          { name: 'Note', value: note, inline: false },
        ],
      });
      await interaction.editReply({ attachments: [], files: [buildStatusCard('Moderator Room Override', `Saved a moderator note for ${voiceChannel}.`, { type: 'success', badge: 'MR' })] });
      return;
    }

    await interaction.editReply({ attachments: [], files: [buildStatusCard('Moderator Room Override', 'That moderator override action is not supported.', { type: 'error', badge: 'ERR' })] });
  } catch (error) {
    console.error('Failed to run moderator room override:', error);
    await interaction.editReply({ attachments: [], files: [buildStatusCard('Moderator Room Override', 'I could not complete that moderator override right now.', { type: 'error', badge: 'ERR' })] });
  }
}

async function handleAutocomplete(interaction) {
  if (!interaction.guild) {
    await interaction.respond([]);
    return;
  }

  if (interaction.commandName !== 'mr' || interaction.options.getSubcommand(false) !== 'transfer') {
    await interaction.respond([]);
    return;
  }

  const focusedOption = interaction.options.getFocused(true);
  if (focusedOption.name !== 'channel') {
    await interaction.respond([]);
    return;
  }

  if (!canUseModeratorOverride(interaction)) {
    await interaction.respond([]);
    return;
  }

  await interaction.respond(buildManagedTransferRoomChoices(interaction.guild, focusedOption.value || ''));
}

async function transferVoiceChannelOwnership({ guild, voiceChannel, actorMember, targetUserId, allowOverride = false }) {
  if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
    return { ok: false, message: 'That voice channel could not be found.' };
  }

  const ownerId = voiceChannelOwners.get(voiceChannel.id);
  if (!ownerId) {
    return { ok: false, message: 'This voice channel is no longer tracked by the bot.' };
  }

  if (!allowOverride && actorMember.id !== ownerId) {
    return { ok: false, message: 'Only the current room owner or bot access role can transfer ownership.' };
  }

  const targetMember = targetUserId ? await guild.members.fetch(targetUserId).catch(() => null) : null;
  if (!targetMember) {
    return { ok: false, message: 'I could not find that server member.' };
  }

  if (targetMember.user.bot) {
    return { ok: false, message: 'Room ownership can only be transferred to a real member.' };
  }

  if (targetMember.id === ownerId) {
    return { ok: false, message: 'That member already owns this voice room.' };
  }

  if (targetMember.voice?.channelId !== voiceChannel.id) {
    return { ok: false, message: `${targetMember} needs to be in your voice room before ownership can be transferred.` };
  }

  rememberActiveChannel(voiceChannel, targetMember.id);
  return { ok: true, targetMember };
}

async function handleTransferOwnerCommand(interaction) {
  if (!interaction.guild) {
    await interaction.reply({ files: [buildStatusCard('Transfer Ownership', 'Run this command inside a server.', { type: 'error', badge: 'ERR' })] });
    return;
  }

  const memberVoiceChannel = interaction.member?.voice?.channel;
  if (!memberVoiceChannel) {
    await interaction.reply({ files: [buildStatusCard('Transfer Ownership', 'Join your active voice room first, then use this command.', { type: 'error', badge: 'ERR' })] });
    return;
  }

  const ownerId = voiceChannelOwners.get(memberVoiceChannel.id);
  if (!ownerId) {
    await interaction.reply({ files: [buildStatusCard('Transfer Ownership', 'This voice channel is no longer tracked by the bot.', { type: 'error', badge: 'ERR' })] });
    return;
  }

  if (!canControlOwnedRoom(interaction, ownerId)) {
    await interaction.reply({ files: [buildStatusCard('Transfer Ownership', 'Only the current room owner or bot access role can transfer ownership.', { type: 'error', badge: 'ERR' })] });
    return;
  }

  await interaction.deferReply();

  const targetUser = interaction.options.getUser('member');
  const isOwnerAction = interaction.member.id === ownerId;
  const previousOwner = isOwnerAction ? interaction.member : await interaction.guild.members.fetch(ownerId).catch(() => null);
  const result = await transferVoiceChannelOwnership({
    guild: interaction.guild,
    voiceChannel: memberVoiceChannel,
    actorMember: interaction.member,
    targetUserId: targetUser?.id,
    allowOverride: !isOwnerAction,
  });

  if (!result.ok) {
    await interaction.editReply({ attachments: [], files: [buildStatusCard('Transfer Ownership', result.message, { type: 'error', badge: 'ERR' })] });
    return;
  }

  await notifyNewOwner(memberVoiceChannel, result.targetMember, {
    previousOwner,
    reason: isOwnerAction ? 'manual' : 'override',
    moderator: isOwnerAction ? null : interaction.member,
  });

  if (!isOwnerAction) {
    await sendModeratorAuditLog(interaction.guild, {
      action: 'Transferred room ownership',
      moderator: interaction.member,
      voiceChannel: memberVoiceChannel,
      details: [
        { name: 'Previous owner', value: previousOwner ? `${previousOwner} (${previousOwner.user.tag})` : `<@${ownerId}>`, inline: false },
        { name: 'New owner', value: `${result.targetMember} (${result.targetMember.user.tag})`, inline: false },
      ],
    });
  }

  await interaction.editReply({
    attachments: [],
    files: [buildStatusCard('Transfer Ownership', `${result.targetMember} is now the owner of ${memberVoiceChannel}.`, { type: 'success', badge: 'OWN' })],
  });
}

function normalizeRoomName(name) {
  return name.trim().replace(/\s+/g, ' ');
}

async function handleRenameRoomCommand(interaction) {
  if (!interaction.guild) {
    await interaction.reply({ files: [buildStatusCard('Rename Room', 'Run this command inside a server.', { type: 'error', badge: 'ERR' })] });
    return;
  }

  const memberVoiceChannel = interaction.member?.voice?.channel;
  if (!memberVoiceChannel) {
    await interaction.reply({ files: [buildStatusCard('Rename Room', 'Join your active voice room first, then use this command.', { type: 'error', badge: 'ERR' })] });
    return;
  }

  const ownerId = voiceChannelOwners.get(memberVoiceChannel.id);
  if (!ownerId) {
    await interaction.reply({ files: [buildStatusCard('Rename Room', 'This voice channel is no longer tracked by the bot.', { type: 'error', badge: 'ERR' })] });
    return;
  }

  if (!canControlOwnedRoom(interaction, ownerId)) {
    await interaction.reply({ files: [buildStatusCard('Rename Room', 'Only the current room owner or bot access role can rename this voice room.', { type: 'error', badge: 'ERR' })] });
    return;
  }

  const requestedName = normalizeRoomName(interaction.options.getString('name') || '');
  if (requestedName.length < 1 || requestedName.length > 100) {
    await interaction.reply({ files: [buildStatusCard('Rename Room', 'Room names must be between 1 and 100 characters.', { type: 'error', badge: 'ERR' })] });
    return;
  }

  await interaction.deferReply();

  try {
    const previousName = memberVoiceChannel.name;
    await memberVoiceChannel.setName(requestedName);
    const savedChannel = botState.activeChannels[memberVoiceChannel.id];
    if (savedChannel) {
      savedChannel.channelName = requestedName;
      savedChannel.updatedAt = new Date().toISOString();
      saveState();
    }

    if (interaction.member.id !== ownerId) {
      await sendModeratorAuditLog(interaction.guild, {
        action: 'Renamed a managed room',
        moderator: interaction.member,
        voiceChannel: memberVoiceChannel,
        details: [
          { name: 'Previous name', value: previousName, inline: true },
          { name: 'New name', value: requestedName, inline: true },
        ],
      });
    }

    await interaction.editReply({ attachments: [], files: [buildStatusCard('Rename Room', `${memberVoiceChannel} has been renamed to ${requestedName}.`, { type: 'success', badge: 'REN' })] });
  } catch (error) {
    console.error('Failed to rename voice room:', error);
    await interaction.editReply({ attachments: [], files: [buildStatusCard('Rename Room', 'I could not rename that voice room right now.', { type: 'error', badge: 'ERR' })] });
  }
}

async function handleTransferOwnerSelect(interaction) {
  const [, voiceChannelId] = interaction.customId.split(':');

  if (!interaction.guild) {
    await interaction.reply({ files: [buildStatusCard('Transfer Ownership', 'Run ownership transfer inside a server.', { type: 'error', badge: 'ERR' })], ephemeral: true });
    return;
  }

  const ownerId = voiceChannelOwners.get(voiceChannelId);
  if (!ownerId) {
    await interaction.reply({ files: [buildStatusCard('Transfer Ownership', 'This voice channel is no longer tracked by the bot.', { type: 'error', badge: 'ERR' })], ephemeral: true });
    return;
  }

  if (!canControlOwnedRoom(interaction, ownerId)) {
    await interaction.reply({ files: [buildStatusCard('Transfer Ownership', 'Only the current room owner or bot access role can use this transfer menu.', { type: 'error', badge: 'ERR' })], ephemeral: true });
    return;
  }

  const voiceChannel = interaction.guild.channels.cache.get(voiceChannelId);
  if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
    await interaction.reply({ files: [buildStatusCard('Transfer Ownership', 'That voice channel could not be found.', { type: 'error', badge: 'ERR' })], ephemeral: true });
    return;
  }

  await interaction.deferReply();

  const isOwnerAction = interaction.member.id === ownerId;
  const previousOwner = isOwnerAction ? interaction.member : await interaction.guild.members.fetch(ownerId).catch(() => null);
  const result = await transferVoiceChannelOwnership({
    guild: interaction.guild,
    voiceChannel,
    actorMember: interaction.member,
    targetUserId: interaction.values[0],
    allowOverride: !isOwnerAction,
  });

  if (!result.ok) {
    await interaction.editReply({ attachments: [], files: [buildStatusCard('Transfer Ownership', result.message, { type: 'error', badge: 'ERR' })] });
    return;
  }

  await notifyNewOwner(voiceChannel, result.targetMember, {
    previousOwner,
    reason: isOwnerAction ? 'manual' : 'override',
    moderator: isOwnerAction ? null : interaction.member,
  });

  if (!isOwnerAction) {
    await sendModeratorAuditLog(interaction.guild, {
      action: 'Transferred room ownership',
      moderator: interaction.member,
      voiceChannel,
      details: [
        { name: 'Previous owner', value: previousOwner ? `${previousOwner} (${previousOwner.user.tag})` : `<@${ownerId}>`, inline: false },
        { name: 'New owner', value: `${result.targetMember} (${result.targetMember.user.tag})`, inline: false },
      ],
    });
  }

  await interaction.editReply({
    attachments: [],
    files: [buildStatusCard('Transfer Ownership', `${result.targetMember} is now the owner of ${voiceChannel}.`, { type: 'success', badge: 'OWN' })],
  });
}

function hasNativeSetupPermission(interaction) {
  return Boolean(
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
      interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)
  );
}

function hasNativeLogPermission(interaction) {
  return Boolean(
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
      interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels) ||
      interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)
  );
}

function memberHasRole(member, roleId) {
  if (!member || !isDiscordId(roleId)) {
    return false;
  }

  const roles = member.roles;
  if (roles?.cache?.has(roleId)) {
    return true;
  }

  if (typeof roles?.has === 'function') {
    return roles.has(roleId);
  }

  if (Array.isArray(roles)) {
    return roles.includes(roleId);
  }

  return false;
}

function getConfiguredBotOwnerIds() {
  return [
    process.env.BOT_OWNER_ID,
    process.env.BOT_OWNER_IDS,
    process.env.OWNER_USER_ID,
    process.env.OWNER_USER_IDS,
  ]
    .filter(Boolean)
    .flatMap((value) => String(value).split(/[\s,]+/))
    .filter(isDiscordId);
}

function getBotOwnerIds() {
  return new Set([...botOwnerIds, ...getConfiguredBotOwnerIds()]);
}

function isBotOwner(interaction) {
  const userId = interaction.user?.id || interaction.member?.id;
  return isDiscordId(userId) && getBotOwnerIds().has(userId);
}

function hasCommandAccessRole(interaction) {
  if (!interaction.guild) {
    return false;
  }

  const roleId = getCommandAccessRoleId(interaction.guild.id);
  return memberHasRole(interaction.member, roleId);
}

function canConfigureAccessRole(interaction) {
  return hasNativeSetupPermission(interaction) || isBotOwner(interaction);
}

function canManageSetup(interaction) {
  return hasNativeSetupPermission(interaction) || hasCommandAccessRole(interaction) || isBotOwner(interaction);
}

function canViewTopHosts(interaction) {
  return canManageSetup(interaction);
}

function canManageXpRoles(interaction) {
  return canManageSetup(interaction);
}

function canManageLogs(interaction) {
  return hasNativeLogPermission(interaction) || hasCommandAccessRole(interaction) || isBotOwner(interaction);
}

function canUseModeratorOverride(interaction) {
  return hasNativeLogPermission(interaction) || hasCommandAccessRole(interaction) || isBotOwner(interaction);
}

function canControlOwnedRoom(interaction, ownerId) {
  return Boolean(ownerId && (interaction.member?.id === ownerId || canUseModeratorOverride(interaction)));
}

function setupSessionKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function channelLabel(guild, channelId) {
  if (!channelId) {
    return 'Not selected';
  }

  const channel = guild.channels.cache.get(channelId);
  return channel ? `${channel.name} (<#${channelId}>)` : `<#${channelId}>`;
}

function buildSetupCard(guild, session, status = null) {
  const colorNumber = status?.color || 0xf97316;
  const color = [
    (colorNumber >> 16) & 0xff,
    (colorNumber >> 8) & 0xff,
    colorNumber & 0xff,
    255,
  ];

  return createCardAttachment({
    badge: 'SET',
    title: 'Voice Room Setup',
    description: status?.message || 'Choose the request voice channel, active category, and archive category. The setup saves when all three are selected.',
    fields: [
      { name: 'Request voice channel', value: channelLabel(guild, session.requestChannelId), inline: false },
      { name: 'Active category', value: channelLabel(guild, session.activeCategoryId), inline: false },
      { name: 'Archive category', value: channelLabel(guild, session.archiveCategoryId), inline: false },
    ],
    color,
  }, 'setup');
}

function buildSetupComponents(userId) {
  return [
    new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(`setup-select:request:${userId}`)
        .setPlaceholder('Request voice channel')
        .setChannelTypes(ChannelType.GuildVoice)
        .setMinValues(1)
        .setMaxValues(1)
    ),
    new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(`setup-select:active:${userId}`)
        .setPlaceholder('Active category')
        .setChannelTypes(ChannelType.GuildCategory)
        .setMinValues(1)
        .setMaxValues(1)
    ),
    new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(`setup-select:archive:${userId}`)
        .setPlaceholder('Archive category')
        .setChannelTypes(ChannelType.GuildCategory)
        .setMinValues(1)
        .setMaxValues(1)
    ),
  ];
}

function validateSetupSession(guild, session) {
  if (!session.requestChannelId || !session.activeCategoryId || !session.archiveCategoryId) {
    return null;
  }

  const requestChannel = guild.channels.cache.get(session.requestChannelId);
  const activeCategory = guild.channels.cache.get(session.activeCategoryId);
  const archiveCategory = guild.channels.cache.get(session.archiveCategoryId);

  if (!requestChannel || requestChannel.type !== ChannelType.GuildVoice) {
    return 'The request channel must be a voice channel.';
  }

  if (!activeCategory || activeCategory.type !== ChannelType.GuildCategory) {
    return 'The active destination must be a category.';
  }

  if (!archiveCategory || archiveCategory.type !== ChannelType.GuildCategory) {
    return 'The archive pool must be a category.';
  }

  if (activeCategory.id === archiveCategory.id) {
    return 'The active category and archive category must be different.';
  }

  return null;
}

async function handleSetupCommand(interaction) {
  if (!interaction.guild) {
    await interaction.reply({ files: [buildStatusCard('Voice Room Setup', 'Run this command inside a server.', { type: 'error', badge: 'ERR' })] });
    return;
  }

  if (!canManageSetup(interaction)) {
    await interaction.reply({ files: [buildStatusCard('Voice Room Setup', 'You need Manage Server, Manage Channels, the configured access role, or bot owner access to run setup.', { type: 'error', badge: 'ERR' })] });
    return;
  }

  await interaction.deferReply();
  await interaction.guild.channels.fetch();

  const key = setupSessionKey(interaction.guild.id, interaction.user.id);
  const session = {
    requestChannelId: null,
    activeCategoryId: null,
    archiveCategoryId: null,
    startedAt: Date.now(),
  };
  setupSessions.set(key, session);

  await interaction.editReply({
    attachments: [],
    files: [buildSetupCard(interaction.guild, session)],
    components: buildSetupComponents(interaction.user.id),
  });
}

async function handleSetupSelect(interaction) {
  const [, field, ownerId] = interaction.customId.split(':');

  if (interaction.user.id !== ownerId) {
    await interaction.reply({ files: [buildStatusCard('Voice Room Setup', 'Only the admin who opened this setup menu can use it.', { type: 'error', badge: 'ERR' })], ephemeral: true });
    return;
  }

  if (!interaction.guild) {
    await interaction.reply({ files: [buildStatusCard('Voice Room Setup', 'Run setup inside a server.', { type: 'error', badge: 'ERR' })], ephemeral: true });
    return;
  }

  if (!canManageSetup(interaction)) {
    await interaction.reply({ files: [buildStatusCard('Voice Room Setup', 'You need Manage Server, Manage Channels, the configured access role, or bot owner access to change setup.', { type: 'error', badge: 'ERR' })], ephemeral: true });
    return;
  }

  const key = setupSessionKey(interaction.guild.id, interaction.user.id);
  const session = setupSessions.get(key);
  if (!session) {
    await interaction.reply({ files: [buildStatusCard('Voice Room Setup', 'That setup menu expired. Run /setup again.', { type: 'warning', badge: 'SET' })], ephemeral: true });
    return;
  }

  await interaction.deferUpdate();

  const selectedChannelId = interaction.values[0];
  if (field === 'request') {
    session.requestChannelId = selectedChannelId;
  } else if (field === 'active') {
    session.activeCategoryId = selectedChannelId;
  } else if (field === 'archive') {
    session.archiveCategoryId = selectedChannelId;
  }

  await interaction.guild.channels.fetch();

  const validationError = validateSetupSession(interaction.guild, session);
  const isComplete = session.requestChannelId && session.activeCategoryId && session.archiveCategoryId;

  if (validationError) {
    await interaction.editReply({
      attachments: [],
      files: [
        buildSetupCard(interaction.guild, session, {
          color: 0xed4245,
          message: validationError,
        }),
      ],
      components: buildSetupComponents(interaction.user.id),
    });
    return;
  }

  if (!isComplete) {
    await interaction.editReply({
      attachments: [],
      files: [buildSetupCard(interaction.guild, session)],
      components: buildSetupComponents(interaction.user.id),
    });
    return;
  }

  const requestChannel = interaction.guild.channels.cache.get(session.requestChannelId);
  const savedCategory = saveConfiguredCategory(interaction.guild.id, {
    name: requestChannel?.name || 'Voice setup',
    requestChannelId: session.requestChannelId,
    activeCategoryId: session.activeCategoryId,
    archiveCategoryId: session.archiveCategoryId,
    createdBy: interaction.user.id,
  });

  setupSessions.delete(key);
  await rebuildGuildIndexes(interaction.guild);

  await interaction.editReply({
    attachments: [],
    files: [
      buildSetupCard(interaction.guild, savedCategory, {
        color: 0x57f287,
        message: 'Setup saved. Members who join the request voice channel will now receive an archived room automatically.',
      }),
    ],
    components: [],
  });
}

async function handleSetupListCommand(interaction) {
  if (!interaction.guild) {
    await interaction.reply({ files: [buildStatusCard('Saved Voice Room Setups', 'Run this command inside a server.', { type: 'error', badge: 'ERR' })] });
    return;
  }

  if (!canManageSetup(interaction)) {
    await interaction.reply({ files: [buildStatusCard('Saved Voice Room Setups', 'You need Manage Server, Manage Channels, the configured access role, or bot owner access to view setup.', { type: 'error', badge: 'ERR' })] });
    return;
  }

  await interaction.deferReply();
  await interaction.guild.channels.fetch();

  const categories = getConfiguredCategories(interaction.guild.id);
  if (categories.length === 0) {
    await interaction.editReply({ attachments: [], files: [buildStatusCard('Saved Voice Room Setups', 'No voice room setups are saved yet. Run /setup to add one.', { type: 'warning', badge: 'SET' })] });
    return;
  }

  const fields = categories.slice(0, 25).map((category) => ({
    name: category.name,
    value: [
      `Request: ${channelLabel(interaction.guild, category.requestChannelId)}`,
      `Active: ${channelLabel(interaction.guild, category.activeCategoryId)}`,
      `Archive: ${channelLabel(interaction.guild, category.archiveCategoryId)}`,
      `Auto-create: ${category.autoCreateArchiveRooms ? `enabled, max ${category.maxArchiveRooms} rooms` : 'disabled'}`,
    ].join('\n'),
  }));

  await interaction.editReply({
    attachments: [],
    files: [createCardAttachment({
      badge: 'LST',
      title: 'Saved Voice Room Setups',
      description: `${categories.length} setup(s) saved for this server.`,
      fields,
    }, 'setup-list')],
  });
}

function truncateOptionText(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3)}...`;
}

async function handleSetupRemoveCommand(interaction) {
  if (!interaction.guild) {
    await interaction.reply({ files: [buildStatusCard('Remove Voice Room Setup', 'Run this command inside a server.', { type: 'error', badge: 'ERR' })] });
    return;
  }

  if (!canManageSetup(interaction)) {
    await interaction.reply({ files: [buildStatusCard('Remove Voice Room Setup', 'You need Manage Server, Manage Channels, the configured access role, or bot owner access to remove setup.', { type: 'error', badge: 'ERR' })] });
    return;
  }

  await interaction.deferReply();
  await interaction.guild.channels.fetch();

  const categories = getConfiguredCategories(interaction.guild.id);
  if (categories.length === 0) {
    await interaction.editReply({ attachments: [], files: [buildStatusCard('Remove Voice Room Setup', 'No voice room setups are saved yet.', { type: 'warning', badge: 'SET' })] });
    return;
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`setup-remove:${interaction.user.id}`)
    .setPlaceholder('Choose a setup to remove')
    .addOptions(
      categories.slice(0, 25).map((category) => ({
        label: truncateOptionText(category.name, 100),
        description: truncateOptionText(`Request: ${interaction.guild.channels.cache.get(category.requestChannelId)?.name || category.requestChannelId}`, 100),
        value: category.requestChannelId,
      }))
    );

  await interaction.editReply({
    attachments: [],
    files: [createCardAttachment({
      badge: 'DEL',
      title: 'Remove Voice Room Setup',
      description: 'Choose the request channel setup to remove. Active occupied rooms should be emptied before removing a setup.',
      color: [237, 66, 69, 255],
    }, 'setup-remove')],
    components: [new ActionRowBuilder().addComponents(menu)],
  });
}

async function handleSetupRemoveSelect(interaction) {
  const [, ownerId] = interaction.customId.split(':');

  if (interaction.user.id !== ownerId) {
    await interaction.reply({ files: [buildStatusCard('Remove Voice Room Setup', 'Only the admin who opened this remove menu can use it.', { type: 'error', badge: 'ERR' })], ephemeral: true });
    return;
  }

  if (!interaction.guild) {
    await interaction.reply({ files: [buildStatusCard('Remove Voice Room Setup', 'Run setup removal inside a server.', { type: 'error', badge: 'ERR' })], ephemeral: true });
    return;
  }

  if (!canManageSetup(interaction)) {
    await interaction.reply({ files: [buildStatusCard('Remove Voice Room Setup', 'You need Manage Server, Manage Channels, the configured access role, or bot owner access to remove setup.', { type: 'error', badge: 'ERR' })], ephemeral: true });
    return;
  }

  await interaction.deferUpdate();

  const requestChannelId = interaction.values[0];
  const category = getConfiguredCategories(interaction.guild.id).find((setup) => setup.requestChannelId === requestChannelId);
  if (!category) {
    await interaction.editReply({
      attachments: [],
      files: [buildStatusCard('Remove Voice Room Setup', 'That setup has already been removed.', { type: 'warning', badge: 'SET' })],
      components: [],
    });
    return;
  }

  const hasActiveRooms = Object.values(botState.activeChannels || {}).some(
    (savedChannel) => savedChannel.guildId === interaction.guild.id && savedChannel.requestChannelId === category.requestChannelId
  );

  if (hasActiveRooms) {
    await interaction.editReply({
      attachments: [],
      files: [buildStatusCard('Remove Voice Room Setup', 'That setup still has active saved rooms. Empty those rooms first, then remove the setup.', { type: 'warning', badge: 'SET' })],
      components: [],
    });
    return;
  }

  const removedCategory = removeConfiguredCategory(interaction.guild.id, requestChannelId);
  await rebuildGuildIndexes(interaction.guild);

  await interaction.editReply({
    attachments: [],
    files: [buildStatusCard('Remove Voice Room Setup', `Removed setup for ${removedCategory ? channelLabel(interaction.guild, removedCategory.requestChannelId) : 'that request channel'}.`, { type: 'success', badge: 'SET' })],
    components: [],
  });
}

function collectApplicationOwnerIds(owner) {
  const ownerIds = new Set();
  if (!owner) {
    return ownerIds;
  }

  if (isDiscordId(owner.ownerId)) {
    ownerIds.add(owner.ownerId);
  }

  if (!owner.members && isDiscordId(owner.id) && (owner.username || owner.globalName || owner.tag)) {
    ownerIds.add(owner.id);
  }

  if (ownerIds.size === 0 && owner.members && typeof owner.members.values === 'function') {
    for (const member of owner.members.values()) {
      if (isDiscordId(member.user?.id)) {
        ownerIds.add(member.user.id);
      } else if (isDiscordId(member.id)) {
        ownerIds.add(member.id);
      }
    }
  }

  return ownerIds;
}

async function refreshBotOwnerIds() {
  try {
    const application = client.application?.fetch
      ? await client.application.fetch()
      : client.application;
    botOwnerIds = collectApplicationOwnerIds(application?.owner || client.application?.owner);
    const ownerCount = getBotOwnerIds().size;

    if (ownerCount > 0) {
      console.log(`Loaded ${ownerCount} bot owner id(s) for command access.`);
    } else {
      console.warn('Could not detect a bot owner. Set BOT_OWNER_ID in .env if owner access is needed.');
    }
  } catch (error) {
    console.warn('Could not fetch the Discord application owner. Set BOT_OWNER_ID in .env if owner access is needed:', error);
  }
}

function buildOwnerAccessibleCommands(commands) {
  return commands.map((command) => {
    const commandData = { ...command };
    delete commandData.default_member_permissions;
    return commandData;
  });
}

async function registerGlobalCommands() {
  try {
    await client.application.commands.set(buildOwnerAccessibleCommands(guildCommands));
    console.log('Registered global slash commands.');
  } catch (error) {
    console.warn('Could not register global slash commands:', error);
  }
}

async function clearGuildCommands(guild) {
  try {
    await guild.commands.set([]);
    console.log(`Cleared guild-specific slash commands for ${guild.name}.`);
  } catch (error) {
    console.warn(`Could not clear guild-specific slash commands for ${guild.name}:`, error);
  }
}

async function initializeGuild(guild) {
  await clearGuildCommands(guild);
  await rebuildGuildIndexes(guild);
}

function isUnknownInteractionError(error) {
  return error?.code === 10062 || error?.rawError?.code === 10062;
}

async function respondToInteractionError(interaction, message) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({
        files: [buildStatusCard('Bot Error', message, { type: 'error', badge: 'ERR' })],
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      files: [buildStatusCard('Bot Error', message, { type: 'error', badge: 'ERR' })],
      ephemeral: true,
    });
  } catch (responseError) {
    if (!isUnknownInteractionError(responseError)) {
      console.error('Failed to send interaction error response:', responseError);
    }
  }
}

async function handleInteractionError(interaction, error) {
  if (interaction.isAutocomplete?.()) {
    console.error('Error handling autocomplete:', error);
    if (!interaction.responded) {
      await interaction.respond([]).catch(() => {});
    }
    return;
  }

  if (isUnknownInteractionError(error)) {
    console.warn('Discord interaction expired before it could be acknowledged. The bot recovered and will continue running.');
    return;
  }

  console.error('Error handling interaction:', error);
  await respondToInteractionError(interaction, 'Something went wrong while handling that Discord action.');
}

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}.`);
  if (clientId) {
    console.log(`Invite link: https://discord.com/api/oauth2/authorize?client_id=${clientId}&scope=applications.commands%20bot&permissions=${botPermissionBits.toString()}`);
  }

  await refreshBotOwnerIds();
  await registerGlobalCommands();

  for (const guild of client.guilds.cache.values()) {
    await initializeGuild(guild);
  }
});

client.on('guildCreate', async (guild) => {
  await initializeGuild(guild);
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    sendVoiceActivityLog(oldState, newState).catch((error) => {
      console.warn('Failed to process voice activity log:', error);
    });

    if (newState.channelId === oldState.channelId) {
      return;
    }

    const now = new Date();

    if (oldState.channelId) {
      const oldChannel = oldState.channel;
      if (oldChannel?.type === ChannelType.GuildVoice) {
        closeRegularMemberSessionForChannel(oldChannel, oldState.member?.id, now);

        const currentOwnerId = voiceChannelOwners.get(oldChannel.id);
        if (currentOwnerId === oldState.member?.id) {
          const newOwner = await assignVoiceChannelOwner(oldChannel);
          await notifyNewOwner(oldChannel, newOwner, {
            previousOwner: oldState.member,
            reason: 'auto',
          });
        }
      }
      await handleEmptyPoolChannel(oldChannel);
    }

    if (newState.channelId) {
      const category = requestChannelById.get(newState.channelId);
      if (category) {
        await handleRequestChannelJoin(newState, category);
      }

      const newChannel = newState.channel;
      if (newChannel?.type === ChannelType.GuildVoice) {
        recordRegularMemberSessionStartForChannel(newChannel, newState.member, now);
      }
    }
  } catch (error) {
    console.error('Error handling voice state update:', error);
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
  if (interaction.isAutocomplete()) {
    await handleAutocomplete(interaction);
    return;
  }

  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'help') {
      await handleHelpCommand(interaction);
      return;
    }

    if (interaction.commandName === 'access-role') {
      await handleAccessRoleCommand(interaction);
      return;
    }

    if (interaction.commandName === 'setup') {
      await handleSetupCommand(interaction);
      return;
    }

    if (interaction.commandName === 'setup-list') {
      await handleSetupListCommand(interaction);
      return;
    }

    if (interaction.commandName === 'setup-check') {
      await handleSetupCheckCommand(interaction);
      return;
    }

    if (interaction.commandName === 'setup-autocreate') {
      await handleSetupAutoCreateCommand(interaction);
      return;
    }

    if (interaction.commandName === 'setup-remove') {
      await handleSetupRemoveCommand(interaction);
      return;
    }

    if (interaction.commandName === 'rooms') {
      await handleRoomsCommand(interaction);
      return;
    }

    if (interaction.commandName === 'tophosts') {
      await handleTopHostsCommand(interaction);
      return;
    }

    if (interaction.commandName === 'hostprofile') {
      await handleHostProfileCommand(interaction);
      return;
    }

    if (interaction.commandName === 'topmembers') {
      await handleTopMembersCommand(interaction);
      return;
    }

    if (interaction.commandName === 'vcprofile') {
      await handleVoiceProfileCommand(interaction);
      return;
    }

    if (interaction.commandName === 'xp-roles') {
      await handleXpRolesCommand(interaction);
      return;
    }

    if (interaction.commandName === 'logs') {
      await handleLogsCommand(interaction);
      return;
    }

    if (interaction.commandName === 'mr') {
      await handleModRoomCommand(interaction);
      return;
    }

    if (interaction.commandName === 'transfer') {
      await handleTransferOwnerCommand(interaction);
      return;
    }

    if (interaction.commandName === 'rename') {
      await handleRenameRoomCommand(interaction);
      return;
    }

    if (interaction.commandName === 'userlimit') {
      const memberVoiceChannel = interaction.member?.voice?.channel;
      if (!memberVoiceChannel) {
        await interaction.reply({ files: [buildStatusCard('Voice Channel Capacity', 'Join a voice channel first, then use this command.', { type: 'error', badge: 'ERR' })] });
        return;
      }

      const ownerId = voiceChannelOwners.get(memberVoiceChannel.id);
      if (!ownerId) {
        await interaction.reply({ files: [buildStatusCard('Voice Channel Capacity', 'This voice channel is no longer tracked by the bot.', { type: 'error', badge: 'ERR' })] });
        return;
      }

      if (!canControlOwnedRoom(interaction, ownerId)) {
        await interaction.reply({ files: [buildStatusCard('Voice Channel Capacity', 'Only the owner or bot access role can change this voice channel capacity.', { type: 'error', badge: 'ERR' })] });
        return;
      }

      await interaction.deferReply();
      const sent = await sendCapacitySelector(memberVoiceChannel, interaction.member);
      await interaction.editReply({
        attachments: [],
        files: [buildStatusCard('Voice Channel Capacity', sent
          ? 'The selector has been posted for your voice channel.'
          : 'I could not post the selector for your voice channel.', {
          type: sent ? 'success' : 'error',
          badge: sent ? 'CAP' : 'ERR',
        })],
      });
      return;
    }
  }

  if (interaction.isChannelSelectMenu() && interaction.customId.startsWith('setup-select:')) {
    await handleSetupSelect(interaction);
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('setup-remove:')) {
    await handleSetupRemoveSelect(interaction);
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('help-page:')) {
    await handleHelpPageSelect(interaction);
    return;
  }

  if (interaction.isUserSelectMenu() && interaction.customId.startsWith('voice-transfer-select:')) {
    await handleTransferOwnerSelect(interaction);
    return;
  }

  if (!interaction.isStringSelectMenu()) {
    return;
  }

  if (!interaction.customId.startsWith('voice-capacity-select:')) {
    return;
  }

  const voiceChannelId = interaction.customId.split(':')[1];
  const ownerId = voiceChannelOwners.get(voiceChannelId);

  if (!ownerId) {
    await interaction.reply({ files: [buildStatusCard('Voice Channel Capacity', 'This voice channel is no longer available for capacity changes.', { type: 'error', badge: 'ERR' })], ephemeral: true });
    return;
  }

  if (!canControlOwnedRoom(interaction, ownerId)) {
    await interaction.reply({ files: [buildStatusCard('Voice Channel Capacity', 'Only the owner or bot access role can change this voice channel capacity.', { type: 'error', badge: 'ERR' })], ephemeral: true });
    return;
  }

  const guild = interaction.guild;
  const voiceChannel = guild?.channels.cache.get(voiceChannelId);

  if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
    await interaction.reply({ files: [buildStatusCard('Voice Channel Capacity', 'That voice channel could not be found.', { type: 'error', badge: 'ERR' })], ephemeral: true });
    return;
  }

  try {
    await interaction.deferUpdate();
    const selectedLimit = Number(interaction.values[0]);
    const previousLimit = formatUserLimit(voiceChannel);
    const updatedChannel = await voiceChannel.setUserLimit(selectedLimit);
    if (interaction.member?.id !== ownerId) {
      await sendModeratorAuditLog(interaction.guild, {
        action: 'Changed a managed room user limit',
        moderator: interaction.member,
        voiceChannel: updatedChannel,
        details: [
          { name: 'Previous limit', value: previousLimit, inline: true },
          { name: 'New limit', value: formatUserLimit(updatedChannel), inline: true },
        ],
      });
    }
    await interaction.editReply({
      attachments: [],
      files: [buildCapacityCard(selectedLimit)],
      components: [],
    });
  } catch (error) {
    console.error('Failed to set voice channel user limit:', error);
    await respondToInteractionError(interaction, 'I could not update the channel limit right now.');
  }
  } catch (error) {
    await handleInteractionError(interaction, error);
  }
});

module.exports = {
  serializePermissionSnapshot,
  normalizePermissionSnapshot,
  buildCapacitySelector,
  buildCapacityCard,
  formatUserLimit,
  capturePermissionOverwrites,
  // Core handlers for testing/simulation
  handleRequestChannelJoin,
  handleEmptyPoolChannel,
  assignVoiceChannelOwner,
  rememberActiveChannel,
  recordRegularMemberSessionStartForChannel,
  closeRegularMemberSessionForChannel,
  sendCapacitySelector,
  notifyNewOwner,
  moveChannelToCategory,
  findAvailableArchiveChannel,
  findTextChannelForVoiceChannel,
  // expose internal maps for inspection
  _internal: {
    requestChannelById,
    poolChannelArchive,
    voiceChannelOwners,
    voiceChannelPermissionSnapshots,
    botState,
  },
};

client.login(token).catch((error) => {
  console.error('Failed to login:', error);
  process.exit(1);
});
