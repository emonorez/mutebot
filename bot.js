// MuteBot — community-voted muting for Discord servers.
// A /mute poll runs for 60 seconds; if yes > no the target is muted for 15 minutes.
// Mute state is persisted to SQLite so it survives restarts and rejoins.

import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ChannelType,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';
import Keyv from 'keyv';
import KeyvSqlite from '@keyv/sqlite';

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('DISCORD_TOKEN environment variable is not set.');
  process.exit(1);
}

// Expiry timestamps (Unix ms) are stored under the key `${guildId}_${userId}`.
const db = new Keyv({ store: new KeyvSqlite('sqlite://data/mutes.db') });
db.on('error', err => console.error('Keyv error:', err));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,               // guild/role/channel cache
    GatewayIntentBits.GuildMessageReactions, // reaction collector for the poll
    GatewayIntentBits.GuildMembers,          // guildMemberAdd + members.fetch() [privileged]
  ],
});

const MUTE_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const POLL_DURATION_MS = 60 * 1000;       // 1 minute

// ---------------------------------------------------------------------------
// Slash command definition (registered with Discord in the clientReady handler)
// ---------------------------------------------------------------------------

const muteCommand = new SlashCommandBuilder()
  .setName('mute')
  .setDescription('Start a community vote to mute a user for 15 minutes')
  .addUserOption(option =>
    option
      .setName('user')
      .setDescription('The user to mute')
      .setRequired(true)
  );

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Returns the existing Muted role or creates it fresh with deny-overwrites
// applied to every channel in the guild. Channels created after this point
// will not have the overwrites and must be handled manually.
async function getOrCreateMutedRole(guild) {
  const existing = guild.roles.cache.find(r => r.name === 'Muted');
  if (existing) return existing;

  const mutedRole = await guild.roles.create({
    name: 'Muted',
    position: 1,
    hoist: true,
    mentionable: true,
    colors: {primaryColor: '#010101'},
    permissions: [],
    reason: 'Role for muting users via MuteBot',
  });

  // Position the Muted role just above @everyone (rank 1). Its rank doesn't
  // affect overwrite effectiveness, but keeping it low is cleaner.
  await mutedRole.setPosition(1).catch(err =>
    console.error('Failed to position Muted role:', err.message)
  );

  await Promise.all(
    guild.channels.cache.map(async channel => {
      try {
        if (
          channel.type === ChannelType.GuildText ||
          channel.type === ChannelType.GuildAnnouncement ||
          channel.type === ChannelType.GuildForum
        ) {
          await channel.permissionOverwrites.edit(mutedRole, {
            SendMessages: false,
            AddReactions: false,
            SendMessagesInThreads: false,
            CreatePublicThreads: false,
            CreatePrivateThreads: false,
          });
        } else if (channel.type === ChannelType.GuildVoice) {
          await channel.permissionOverwrites.edit(mutedRole, {
            Connect: false,
            SendMessages: false, // voice channels have a text chat tab
          });
        } else if (channel.type === ChannelType.GuildStageVoice) {
          await channel.permissionOverwrites.edit(mutedRole, {
            Connect: false,
            Speak: false,
            SendMessages: false,
          });
        }
      } catch (err) {
        console.error(`Failed to set permissions on #${channel.name}:`, err.message);
      }
    })
  );

  return mutedRole;
}

// Schedules the role removal and DB cleanup after delayMs milliseconds.
// db.delete runs unconditionally first so stale entries never persist,
// even if the member has left the server by the time the timer fires.
function scheduleUnmute(member, mutedRole, guild, delayMs) {
  setTimeout(async () => {
    await db.delete(`${guild.id}_${member.id}`);
    try {
      await member.roles.remove(mutedRole);
      console.log(`[${new Date().toISOString()}] Unmuted ${member.user.username} in ${guild.name}`);
    } catch (err) {
      console.error(`Failed to remove mute role from ${member.user.username}:`, err.message);
    }
  }, delayMs);
}

// Applies the mute role, persists the expiry timestamp, and schedules the unmute.
async function applyMute(member, mutedRole, guild) {
  const expiry = Date.now() + MUTE_DURATION_MS;
  await member.roles.add(mutedRole);
  await db.set(`${guild.id}_${member.id}`, expiry);
  console.log(`[${new Date().toISOString()}] Muted ${member.user.username} in ${guild.name}`);
  scheduleUnmute(member, mutedRole, guild, MUTE_DURATION_MS);
}

// ---------------------------------------------------------------------------
// /mute command handler
// ---------------------------------------------------------------------------

async function muteUser(interaction) {
  const { guild } = interaction;
  const targetUser = interaction.options.getUser('user');

  // Cheap synchronous guards before the interaction is deferred.
  if (targetUser.bot) {
    return interaction.reply({ content: "You can't mute a bot.", ephemeral: true });
  }
  if (targetUser.id === interaction.user.id) {
    return interaction.reply({ content: "You can't mute yourself.", ephemeral: true });
  }

  // Defer immediately — role creation can exceed Discord's 3-second response window.
  await interaction.deferReply();

  const member = await guild.members.fetch(targetUser.id).catch(() => null);
  if (!member) {
    return interaction.editReply('That user is not in this server.');
  }

  const mutedRole = await getOrCreateMutedRole(guild);

  if (member.roles.cache.has(mutedRole.id)) {
    return interaction.editReply(`<@${targetUser.id}> is already muted.`);
  }

  // Send the poll embed and attach reactions.
  const embed = new EmbedBuilder()
    .setColor(0x00ff00)
    .setTitle(`Vote to mute ${targetUser.username}`)
    .setDescription('Should this user be muted for 15 minutes?\n\nThis poll closes in 1 minute.')
    .setThumbnail(targetUser.displayAvatarURL({ size: 128 }))
    .setFooter({ text: `Poll started by ${interaction.user.username}` })
    .setTimestamp();

  const pollMessage = await interaction.editReply({ embeds: [embed] });
  await pollMessage.react('👍');
  await pollMessage.react('👎');

  // Track voters by ID to prevent a single user from casting multiple votes.
  const voters = new Set();
  const votes = { yes: 0, no: 0 };

  const filter = (reaction, user) =>
    ['👍', '👎'].includes(reaction.emoji.name) && !user.bot;

  const collector = pollMessage.createReactionCollector({ filter, time: POLL_DURATION_MS });

  collector.on('collect', (reaction, user) => {
    if (voters.has(user.id)) return;
    voters.add(user.id);
    if (reaction.emoji.name === '👍') votes.yes++;
    else votes.no++;
  });

  collector.on('end', async () => {
    if (votes.yes > votes.no && votes.yes >= 3) {
      await applyMute(member, mutedRole, guild);
      await interaction.followUp(
        `<@${targetUser.id}> has been muted for 15 minutes. (${votes.yes}–${votes.no})`
      );
    } else {
      await interaction.followUp(
        `Poll to mute <@${targetUser.id}> failed. (${votes.yes}–${votes.no})`
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

// Re-apply the mute if a muted user leaves and rejoins before the mute expires.
client.on('guildMemberAdd', async member => {
  const expiry = await db.get(`${member.guild.id}_${member.id}`);
  if (!expiry) return;

  const remaining = expiry - Date.now();
  if (remaining <= 0) {
    // Mute expired while they were gone — clean up the stale DB entry.
    await db.delete(`${member.guild.id}_${member.id}`);
    return;
  }

  const mutedRole = member.guild.roles.cache.find(r => r.name === 'Muted');
  if (!mutedRole) return;

  try {
    await member.roles.add(mutedRole);
    console.log(`[${new Date().toISOString()}] Re-muted rejoining user ${member.user.username}`);
    scheduleUnmute(member, mutedRole, member.guild, remaining);
  } catch (err) {
    console.error(`Failed to re-apply mute to ${member.user.username}:`, err.message);
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'mute') return;
  try {
    await muteUser(interaction);
  } catch (err) {
    console.error('Error handling /mute:', err);
    // Reply method depends on how far through the interaction lifecycle we got.
    const content = 'An error occurred. Please try again.';
    if (interaction.replied) {
      await interaction.followUp({ content, ephemeral: true }).catch(() => {});
    } else if (interaction.deferred) {
      await interaction.editReply({ content }).catch(() => {});
    } else {
      await interaction.reply({ content, ephemeral: true }).catch(() => {});
    }
  }
});

client.once('clientReady', async () => {
  console.log(`[${new Date().toISOString()}] Logged in as ${client.user.tag}`);

  // Register the /mute slash command globally. This runs on every startup but
  // is idempotent — Discord ignores re-registration of identical commands.
  const rest = new REST({ version: '10' }).setToken(token);
  try {
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: [muteCommand.toJSON()] },
    );
    console.log('Slash commands registered.');
  } catch (err) {
    console.error('Failed to register slash commands:', err);
  }

  // Restore unmute timers that were lost during a restart.
  // For each guild, fetch all members and reschedule any whose mute is still active.
  for (const guild of client.guilds.cache.values()) {
    const mutedRole = guild.roles.cache.find(r => r.name === 'Muted');
    if (!mutedRole) continue;

    const members = await guild.members.fetch().catch(() => null);
    if (!members) continue;

    for (const member of members.values()) {
      const expiry = await db.get(`${guild.id}_${member.id}`);
      if (!expiry) continue;

      const remaining = expiry - Date.now();
      if (remaining <= 0) {
        // Mute expired during downtime — remove role and clean up.
        await member.roles.remove(mutedRole).catch(() => {});
        await db.delete(`${guild.id}_${member.id}`);
      } else {
        scheduleUnmute(member, mutedRole, guild, remaining);
      }
    }
  }

});

client.login(token);
