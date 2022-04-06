const Discord = require('discord.js');
const Keyv = require('keyv');
const token = '' ;
const prefix = '';
var log_channel = 000000000000000000;
const client = new Discord.Client();
db = new Keyv();

db.on('error', err => console.log('Database Connection Error', err));

// role persistence event
client.on('guildMemberAdd', async (member) => {
    try { //try to execute this
        const inmate = await db.get(member.id) //search the member that joined in the outlaw database
        const i = 1
        if(inmate){ //and if they are in there
            const role = await member.guild.roles.cache.find(r => r.name === 'Muted'); //find role
            await member.roles.add(role) //mute the fucker again
            x = i + await db.get(member.id);
            if (x >= 4) {
                const channel = client.channels.cache.find(ch => ch.id == log_channel);
                channel.send('<@!' + member.id + '>' + ' is being a very bothersome user, they have rejoined to avoid mute a total of ' + x + ' times now.');
            }
            await db.delete(member.id); 
            await db.set(member.id, x, 900000 * x ) //add the muted into the database, with a longer mute
            setTimeout(() => {  msg.mentions.members.first().roles.remove(role);  }, 900000 * x); //wait 15 minutes, remove role
        }
    } catch (e) { //but if it fails...do this
        console.log(e);
        const channel = client.channels.cache.find(ch => ch.id == log_channel);
        return channel.send('I seem to have failed, I need help.');
    }
});

client.on('message', async (msg) => {
    try { //try to execute this
        if (!msg.content.startsWith(prefix)) return; //returns if message didn't start with the defined prefix
        if(msg.author.equals(client.user)) return; //returns if bot tries to mute themselves
        
        const role = await msg.guild.roles.cache.find(r => r.name === 'Muted'); //find role
        if(!role) return msg.channel.send('No role was found, please make sure you have a Muted role!'); //make sure there is a role
        
        if(!msg.mentions.users.first()) return msg.channel.send('You need to mention somebody!'); //check if no user was mentioned
        if(msg.mentions.has(client.user)) return msg.channel.send('Go mute yourself, bitch.'); //return message if user was trying to mute this bot
        if(msg.mentions.members.first().roles.cache.has(role.id)) return msg.channel.send('User is already muted.'); //return message if user already has mute role
        
        const voting = new Discord.MessageEmbed() //generate voting embed
        .setColor('#42b34d')
        .setTitle('Vote to mute this fucker!')
        .setDescription('Do you want to mute this bastard?')
        .setFooter('Mute ' + msg.mentions.users.first().tag + ' for 15m?')
        .setImage(msg.mentions.users.first().displayAvatarURL());
        const sentEmbed = await msg.channel.send(voting); //send embed
        
        const agree = '✅'; //define agree emoji
        const disagree = '❌'; //define disagree emoji
        await sentEmbed.react(agree); //react with agree emoji
        await sentEmbed.react(disagree); //react with disagree emoji
        const filter = (reaction, user) => (reaction.emoji.name === agree || reaction.emoji.name === disagree) && !user.bot; //filter for reactions
        const voteStatus = await msg.channel.send('@everyone' + ' Voting has started, 1 minute left...'); //start message
        const collected = await sentEmbed.awaitReactions(filter, { time: 60000 }); //start collecting reactions
        const agreed = collected.get(agree) || { count: 1 }; //retrieve reactions
        const disagreed = collected.get(disagree) || { count : 1 }; //retrieve reactions
        const agreed_count = agreed.count - 1 ; //count away bot votes
        const disagreed_count = disagreed.count - 1; //count away bot votes
        voteStatus.edit('Voting ended with: ' + agreed_count + agree + ' and ' + disagreed_count + disagree); //edit message to show outcome
        if (agreed.count > disagreed.count && agreed.count >= 4) {
            await msg.mentions.members.first().roles.add(role); //add the muted role to said user
            await db.set(msg.mentions.users.first().id, 1, 900000) //add the muted's id into the database, expires in 15 minutes
            setTimeout(() => {  msg.mentions.members.first().roles.remove(role);  }, 900000); //wait 15 minutes, remove role
        }
        else {
            msg.channel.send('Mute voting failed :)'); //oops, voting failed :(
        }
    } catch (e) { //but if it fails...do this
        return msg.channel.send('I seem to have failed, please contact the administration team.');
    }
});

client.on('ready', () => {
    console.log ('Dziala');
    client.user.setActivity('weak-minded individuals.', { type: 'WATCHING' })
});

client.login(token);