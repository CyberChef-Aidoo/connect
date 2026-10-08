import { ApiError } from './api';

export type ShareAction = 'check' | 'open' | 'preview' | 'publish' | 'stop' | 'download' | 'direct';

const KNOWN: Record<string, string> = {
  'Name this share.': 'Enter a name, then start sharing.',
  'Choose at least one file with a safe path.': 'Choose at least one file with a normal name, then try again.',
  'Choose people who are here.': 'Tick people who have this page open, then start sharing again.',
  'That folder path cannot be opened.': 'That folder could not be opened. Go back to the top of the share and try again.',
  'That download is no longer waiting.': 'That download is no longer waiting. Start it again.',
  'The file size does not match the share.': 'The file did not match what was shared. Ask the sender to choose the files again.',
  'The file ended early.': 'The file arrived incomplete. Keep the sender’s tab open and try Download again.',
  'That share is not yours.': 'You can stop only a share started in this browser.',
  'That share is not available to you.': 'This share was not offered to you. Ask the sender to include your name and share again.',
  'You cannot download this share.': 'You cannot download this share. Ask the sender to tick your name and share again.',
  'The person sharing these files is not here. The share stays read-only and is not watched for changes.': 'The other person is not here. Ask them to open the files again. Files they add later are not included.',
  'Too many downloads are already running.': 'Too many downloads are already running. Wait for one to finish, then try again.',
  'That folder path cannot be downloaded.': 'That folder cannot be downloaded. Open a folder from the list and try again.',
  'That file is not in the share.': 'That file is not in this share. Choose a file from the list.',
  'That path cannot be shared.': 'This item was left out because its name is not safe to share.',
  'That file size cannot be shared.': 'This item was left out because its size is not valid.',
  'The sender did not provide this file.': 'The sender did not send this file. Ask them to keep this page open and try Download again.',
  'The sender does not still have this file.': 'The sender no longer has this file open. Ask them to choose the files again, then try Download.',
  'The sender did not finish this file.': 'The sender did not finish this file. Ask them to keep this page open and try Download again.',
  'This share was revoked.': 'Sharing was stopped. New downloads are refused. Copies already downloaded stay with the people who received them.',
  'The server returned the website instead of an API response.': 'The page received the wrong response. Refresh it and try again.',
  'The share request was refused.': 'The request was refused. Refresh the page and try again.',
  'Direct download was canceled.': 'The download from their browser was canceled.',
  'Direct download did not start. Use Download through this computer.': 'The download from their browser did not start. Use Download instead.',
  'The sender does not still have this file open. Use Download through this computer.': 'The sender no longer has this file open. Use Download, or ask them to choose the files again.',
  'The direct download stopped early.': 'The download from their browser stopped before the file was complete. Use Download.',
  'Direct download is not available.': 'A download from their browser is not available. Use Download.',
  'The direct connection closed.': 'The download from their browser closed early. Use Download.',
  'Sign in required.': 'This browser is not signed in. Refresh the page and try again.',
  'This page is out of date. Refresh it and try again.': 'This page is out of date. Refresh it and try again.',
  'This action must come from this portal.': 'This action was refused. Use the buttons on this page and try again.',
};

function lead(action: ShareAction): string {
  switch (action) {
    case 'check': return 'The connection check failed.';
    case 'open': return 'The share did not open.';
    case 'preview': return 'Those files could not be checked.';
    case 'publish': return 'Sharing did not start.';
    case 'stop': return 'Sharing was not stopped.';
    case 'download': return 'The download did not start.';
    case 'direct': return 'The download from their browser did not start.';
  }
}

function nextStep(action: ShareAction, status: number): string {
  if (status === 401) return 'Refresh the page and try again.';
  if (status === 403) return 'Ask the sender to include you, then try again.';
  if (status === 404) return 'Go back to the list and choose the share again.';
  if (status === 409) return 'Ask the other person to open this page, then try again.';
  if (status === 429) return 'Wait for another download to finish, then try again.';
  if (status === 400) return 'Check the selection, then try again.';
  if (status === 502 || status === 504) return 'Ask the sender to keep this page open, then try Download again.';
  if (action === 'check') return 'Stay on the same network, then refresh the page.';
  return 'Try again. If it keeps happening, open Help and copy the connection details.';
}

export function explainShareError(action: ShareAction, error: unknown): string {
  const raw = error instanceof Error ? error.message : '';
  if (raw && Object.prototype.hasOwnProperty.call(KNOWN, raw)) return KNOWN[raw];
  const limited = raw.match(/^Choose (\d+) files or fewer\.$/);
  if (limited) return `Select ${limited[1]} files or fewer, then try again.`;
  if (raw.startsWith('The sender ')) {
    return 'The sender did not finish this file. Ask them to keep this page open and try Download again.';
  }
  const status = error instanceof ApiError ? error.status : 0;
  if (error instanceof TypeError || status === 0) {
    return action === 'check'
      ? 'This browser cannot reach the computer that holds the files. Stay on the same network, then refresh the page.'
      : 'This browser cannot reach the computer that holds the files. Stay on the same network, then try again.';
  }
  return `${lead(action)} ${nextStep(action, status)}`;
}

export function explainRejected(reason: string): string {
  if (Object.prototype.hasOwnProperty.call(KNOWN, reason)) return KNOWN[reason];
  const limited = reason.match(/^Choose (\d+) files or fewer\.$/);
  if (limited) return `Select ${limited[1]} files or fewer.`;
  return 'This item was left out. Choose a different file.';
}

export function connectionPlain(input: { checking: boolean; reachable: boolean; signedOut: boolean }): { title: string; detail: string } {
  if (input.signedOut) {
    return {
      title: 'This browser is not signed in.',
      detail: 'Refresh the page. Reaching this computer does not by itself share any files.',
    };
  }
  if (!input.reachable && input.checking) {
    return {
      title: 'Checking whether this browser can reach the file computer…',
      detail: 'This check does not start a share.',
    };
  }
  if (!input.reachable) {
    return {
      title: 'This browser cannot reach the computer that holds the files.',
      detail: 'Stay on the same network, then refresh the page.',
    };
  }
  return {
    title: 'This browser can reach the file computer.',
    detail: 'That only means the page can talk to it. Keep this tab open while you share or download.',
  };
}

export function browsersHere(names: string[]): string {
  if (names.length === 0) return 'No other browser has this page open.';
  if (names.length === 1) return `${names[0]} has this page open in another browser.`;
  return `Other browsers open now: ${names.join(', ')}.`;
}

export function transferLabel(mode: 'idle' | 'download' | 'direct'): string {
  if (mode === 'download') return 'Sent to your browser’s download list';
  if (mode === 'direct') return 'Downloading from their browser';
  return 'Not transferring';
}

export type SupportFacts = {
  build: string;
  origin: string;
  reachable: boolean;
  signedOut: boolean;
  registered: boolean;
  lastCheck: string;
  browsers: string[];
  sharesReady: number;
  directAvailable: boolean;
  transfer: string;
  lastProblem: string;
  lastStatus: number | null;
};

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').slice(0, 80);
}

export function supportDetails(facts: SupportFacts): string {
  const names = facts.browsers.map(oneLine).filter(Boolean);
  const problem = facts.lastProblem ? oneLine(facts.lastProblem) : 'none';
  return [
    'Connection details',
    `Build: ${oneLine(facts.build)}`,
    `Address: ${oneLine(facts.origin)}`,
    `Can reach the file computer: ${facts.reachable ? 'yes' : 'no'}`,
    `Signed in: ${facts.signedOut ? 'no' : 'yes'}`,
    `This browser checked in: ${facts.registered ? 'yes' : 'no'}`,
    `Last successful check: ${facts.lastCheck || 'none'}`,
    `Other browsers: ${names.length}${names.length > 0 ? ` (${names.join(', ')})` : ''}`,
    `Shares with files still open: ${facts.sharesReady}`,
    `Browser-to-browser download: ${facts.directAvailable ? 'available' : 'not available on this address'}`,
    `Transfer: ${oneLine(facts.transfer)}`,
    `Last problem: ${problem}${facts.lastStatus ? ` (code ${facts.lastStatus})` : ''}`,
  ].join('\n');
}
