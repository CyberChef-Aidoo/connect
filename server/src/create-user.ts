import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { passwordProblem } from './passwords.js';
import { createUser, usernameProblem } from './users.js';

const config = loadConfig();
const prompted = createInterface({ input: stdin, output: stdout });

try {
  const username = (process.argv[2] ?? await prompted.question('Username: ')).trim();
  const nameError = usernameProblem(username);
  if (nameError) {
    console.error(nameError);
    process.exitCode = 1;
  } else {
    const fromEnv = process.env.PORTAL_NEW_PASSWORD;
    const password = fromEnv ?? await prompted.question('Password (visible as you type): ');
    const problem = passwordProblem(password);
    if (problem) {
      console.error(problem);
      process.exitCode = 1;
    } else {
      const db = openDatabase(config.databasePath);
      try {
        await createUser(db, username, password);
        console.log(`Created user ${username}.`);
      } catch (error) {
        console.error(error instanceof Error ? error.message : 'The user could not be created.');
        process.exitCode = 1;
      } finally {
        db.close();
      }
    }
  }
} finally {
  prompted.close();
  if (process.env.PORTAL_NEW_PASSWORD) {
    delete process.env.PORTAL_NEW_PASSWORD;
  }
}
