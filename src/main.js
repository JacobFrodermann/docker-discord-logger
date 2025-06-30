require('dotenv').config();
const childProcess = require('child_process');
const { Webhook } = require('discord-webhook-node');

if(!process.env.WEBHOOK_URL) {
    console.error('Please specify the Discord webhook url in environment variable WEBHOOK_URL.');
    process.exit(1);
}

console.log('Starting docker discord logger...');

const Docker = require('dockerode');
const docker = new Docker(); // Assumes standard docker socket path

// Initialize discord webhook
const discordWebhook = new Webhook(process.env.WEBHOOK_URL);
discordWebhook.send('Started docker discord logger.').catch(e => {
    console.log('Provided webhook url is invalid: '+e.message);
    process.exit(1);
});

(async () => {
    // Add running containers on start
    let containers = process.env.CONTAINERS ? process.env.CONTAINERS.split(':') : [];
    containers.push(...(await getLabeledContainers('discord-logger.enabled=true')));
    containers = [...new Set(containers)];
    containers.forEach(containerName => {
        monitorContainer(containerName, false);
    });

    // Listen for started containers
    const dockerEventListener = childProcess.spawn('docker', ['events', '--filter', 'event=start', '--format', '{{json .}}'], {
        detached: true
    });
    dockerEventListener.stdout.on('data', data => {
        data = JSON.parse(data.toString());
        let containerName = containers.find(container => container == data.Actor.Attributes.name || data.id.startsWith(container));

        if(!containerName && data.Actor.Attributes['discord-logger.enabled'] == 'true') {
            containerName = data.Actor.Attributes.name;
        }

        if(containerName) {
            console.log(`Container "${containerName}" started, attaching listener.`);
            monitorContainer(containerName, true);
        }
    });
    dockerEventListener.on('close', () => {
        console.log('Event listener process exited.');
    });
})();

// Monitor individual containers
function monitorContainer(containerName, notifyDiscord) {
    const container = docker.getContainer(containerName);

    container.logs({
        follow: true,
        stdout: true,
        stderr: true,
        tail: 0
    }, (err, stream) => {
        if (err) {
            console.error(err.message);
            return;
        }

        stream.on('data', chunk => {
            // Docker multiplexes stdout and stderr, need to demultiplex
            // The first 8 bytes of the chunk are a header.
            // For simplicity here, we just strip the header and process.
            // A full solution would parse the header to see if it's stdout/stderr.
            const message = chunk.toString('utf8').substring(8).trim();
            if (message.includes("error")) {
                discordWebhook.send(`\`\`\`ansi\n**[${containerName}]** [2;30m[2;31m${message}[0m[2;30m[0m\`\`\``);
                
            } else {
                discordWebhook.send(`**[${containerName}]** ${message}`);
            }
        });

        stream.on('end', () => {
             discordWebhook.send(`Container **"${containerName}"** exited.`);
        });
    });

    if (notifyDiscord) discordWebhook.send(`Container **"${containerName}"** started.`);
}

async function getLabeledContainers(label) {
    return new Promise(resolve => {
        childProcess.exec(`docker ps --filter=label=${label} --format='{{json .}}'`, (error, stdout, stderr) => {
            if(stderr) {
                console.error(`Error while checking running containers: `+stderr);
            }

            const containers = [];
            stdout.split('\n').forEach(container => {
                if(!container) return;
                container = JSON.parse(container);
                containers.push(container.Names);
            });
            resolve(containers);
        });
    });
}
