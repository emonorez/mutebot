const { token } = require('./config.json');
const { Client, Intents, MessageEmbed } = require('discord.js');

const Keyv = require('keyv');
db = new Keyv();

const client = new Client({
  intents: [
    Intents.FLAGS.GUILDS,
    Intents.FLAGS.GUILD_MESSAGES,
    Intents.FLAGS.GUILD_MESSAGE_REACTIONS,
    Intents.FLAGS.GUILD_MEMBERS,
  ],
});

async function MutedRole(guild) {
  try {
    const mutedRole = await guild.roles.create({
      name: 'Muted',
      color: '#010101',
      permissions: [],
    });

    guild.channels.cache.forEach(async (channel, id) => {
      try {
        if (channel.type === 'GUILD_TEXT') {
          await channel.permissionOverwrites.edit(mutedRole, {
            SEND_MESSAGES: false,
            ADD_REACTIONS: false
          });
        } else if (channel.type === 'GUILD_VOICE'){
          await channel.permissionOverwrites.edit(mutedRole, {
            CONNECT: false
          });
        }
      } catch (err) {
        console.error(`Error setting permissions for channel ${channel.name}:`, err);
      }
    });

    return mutedRole;
  } catch (err) {
    console.error('Error creating muted role:', err);
  }
}

async function muteUser(interaction) {
  const guild = interaction.guild;
  const user = interaction.options.getUser('user');
  const member = guild.members.cache.get(user.id);

  // Check if user is a bot
  if (user.bot) {
    return interaction.reply("You can't mute a bot.");
  }

  // Check if the Muted role exists, and create it if not
  const mutedRole = guild.roles.cache.find(role => role.name === 'Muted') ?? await MutedRole(guild);

  // Check if the user is already muted
  if (member.roles.cache.has(mutedRole.id)) {
    await interaction.followUp(`${user.tag} is already muted.`);
    return;
  }

  // Create the poll embed message
  const embed = new MessageEmbed()
    .setColor('#00ff00')
    .setTitle(`Vote to mute ${user.username}#${user.discriminator}`)
    .setDescription(`Do you agree to mute this user?\n\nThis poll will last for 1 minute.`)
    .setThumbnail(user.avatarURL({ size: 128, dynamic: true }))
    .setFooter({ 'text': `Poll started by ${interaction.user.username}#${interaction.user.discriminator}` })
    .setTimestamp()

  // Send the poll embed message and add reactions
  const pollMessage = await interaction.reply({ embeds: [embed], fetchReply: true });
  await pollMessage.react('👍');
  await pollMessage.react('👎');

  // Create a reaction collector to tally votes
  const filter = (reaction, user) => ['👍', '👎'].includes(reaction.emoji.name) && !user.bot;
  const collector = pollMessage.createReactionCollector({ filter, time: 60000 });
  let yesVotes = 0;
  let noVotes = 0;

  // Listen for reactions and tally the votes
  collector.on('collect', (reaction, user) => {
    if (reaction.emoji.name === '👍') {
      yesVotes++;
    } else if (reaction.emoji.name === '👎') {
      noVotes++;
    }
  });

  // After the poll ends, determine the outcome and act accordingly
  collector.on('end', async () => {
    if (yesVotes > noVotes) {
      // Mute the user
      await member.roles.add(mutedRole.id);
      await db.set(`${guild.id}_${user.id}`);
      console.log(`Muted user ${user.id} in guild ${guild.id} at ${new Date().toISOString()}`);
      await interaction.followUp(`User ${user.username}#${user.discriminator} has been muted.`);
      setTimeout(async () => {
        await member.roles.remove(mutedRole.id);
        await db.delete(`${guild.id}_${user.id}`);
      }, 900000); // Remove the mute role and delete the TTL after 15 minutes
    } else {
      await interaction.followUp(`Poll to mute user ${user.username}#${user.discriminator} failed.`);
    }
  });
}

client.on('guildMemberAdd', async (member) => {
  // Check if the user had been previously muted
  const muted = await db.get(`${member.guild.id}_${member.id}`);
  if (muted) {
    // Assign the Muted role to the user
    const mutedRole = member.guild.roles.cache.find(role => role.name === 'Muted');
    try {
      await member.roles.add(mutedRole);
    } catch (error) {
      console.error(`Error assigning Muted role to user ${member.user.tag}:`, error);
    }
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand() || interaction.commandName !== 'mute') return;
  await muteUser(interaction);
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}!`);
  client.user.setActivity('weak-minded individuals.', { type: 'WATCHING' })
});

client.login(token);