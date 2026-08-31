import { spawn } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

const isWin = os.platform() === 'win32';
const pendingMessages = new Set<string>();
const loggedMessages = new Set<string>();

function scriptPath(projectDir: string, name: string): string {
    // projectDir comes from the developer's own opencode plugin config, never from user input.
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    return path.join(projectDir, 'scripts', name);
}

function sendLog(projectDir: string, eventPayload: any) {
    try {
        // Node >= 20.12 refuses to spawn .cmd/.bat files with shell:false
        // (CVE-2024-27980 hardening), so on Windows route through cmd.exe
        // with /s (strip outer quotes) and quoted arguments.
        let launcher: string;
        let args: string[];
        if (isWin) {
            launcher = 'cmd.exe';
            args = ['/d', '/s', '/c', scriptPath(projectDir, '_pyrun.cmd'), scriptPath(projectDir, 'log_hook.py'), '--tool=opencode'];
        } else {
            launcher = 'bash';
            args = [scriptPath(projectDir, '_pyrun.sh'), scriptPath(projectDir, 'log_hook.py'), '--tool=opencode'];
        }
        const projectCwd = projectDir;
        writeDebugLog(projectDir, 'sendLog.call', { projectDir, cwd: projectCwd, launcher, args });
        // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process
        const child = spawn(launcher, args, { cwd: projectCwd, stdio: ['pipe', 'ignore', 'ignore'], shell: false, windowsVerbatimArguments: true });
        child.stdin.write(JSON.stringify(eventPayload));
        child.stdin.end();
        child.on('error', (err) => {
            writeDebugLog(projectDir, 'sendLog.childError', { message: err.message });
        });
        child.on('exit', (code, sig) => {
            writeDebugLog(projectDir, 'sendLog.exit', { code, signal: sig ? String(sig) : null });
        });
    } catch (err: any) {
        writeDebugLog(projectDir, 'sendLog.error', { message: err.message });
    }
}

function writeDebugLog(projectDir: string, hookName: string, data: any) {
    try {
        // projectDir is the developer's own plugin config path, not user input.
        // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
        const logDir = path.join(projectDir, '.ai-log');
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
        // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
        const debugFile = path.join(logDir, 'debug.log');
        const logLine = `[${new Date().toISOString()}] hook=${hookName} payload=${JSON.stringify(data)}\n`;
        fs.appendFileSync(debugFile, logLine);
    } catch (e) { /* ignore */ }
}

function getMessages(response: any): any[] {
    if (Array.isArray(response)) return response;
    if (response?.data && Array.isArray(response.data)) return response.data;
    if (response?.messages && Array.isArray(response.messages)) return response.messages;
    return [];
}

async function fetchAndLog(client: any, projectDir: string, sessionID: string, messageID: string) {
    for (let i = 0; i < 10; i++) {
        try {
            const response = await client.session.messages({ path: { id: sessionID } });
            const msgs = getMessages(response);
            if (i === 0) {
                const sample = Array.isArray(response?.data) ? (response.data[0] ? JSON.stringify(response.data[0]).substring(0,200) : 'empty array') : 'data not array';
                writeDebugLog(projectDir, 'fetch.response', { messageID, type: typeof response, keys: Object.keys(response), sample });
            }
            const userMsg = msgs.find((m: any) => m.info?.id === messageID);
            writeDebugLog(projectDir, 'fetch.userMsg', { messageID, found: !!userMsg, partsCount: userMsg?.parts?.length ?? 0 });
            if (userMsg && userMsg.parts && userMsg.parts.length > 0) {
                const textPart = userMsg.parts.find((p: any) => p.type === 'text');
                writeDebugLog(projectDir, 'fetch.textPart', { messageID, found: !!textPart, textLen: textPart?.text?.length ?? 0 });
                if (textPart && textPart.text) {
                    sendLog(projectDir, {
                        event: 'UserPromptSubmit',
                        source: 'opencode',
                        prompt: textPart.text,
                        session_id: sessionID,
                    });
                    loggedMessages.add(messageID);
                    pendingMessages.delete(messageID);
                    return;
                }
            }
        } catch (e) {
            writeDebugLog(projectDir, 'fetch.error', { messageID, error: String(e) });
        }
        await new Promise(r => setTimeout(r, 1000));
    }
    writeDebugLog(projectDir, 'fetch.timeout', { messageID });
    pendingMessages.delete(messageID);
}

export const AILogger = async ({ directory, client }: any) => {
    return {
        event: async ({ event }: any) => {
            if (!event) return;
            const props = event.properties || {};

            if (event.type === 'message.updated' && props.info) {
                const info = props.info;
                if (info.role === 'user' && info.id && !loggedMessages.has(info.id) && !pendingMessages.has(info.id)) {
                    pendingMessages.add(info.id);
                    fetchAndLog(client, directory, props.sessionID, info.id);
                }
                return;
            }

            if (event.type === 'session.idle' || event.type === 'session.deleted') {
                sendLog(directory, {
                    event: 'SessionEnd',
                    source: 'opencode',
                    session_id: props?.sessionID || '',
                });
            }
        }
    };
};
