import { migrateSqliteToMysql } from './migrate.js';

interface CliOptions {
  sqlitePath?: string;
  mysqlUrl?: string;
  dryRun: boolean;
  help: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }
  if (!options.sqlitePath) throw new Error('--sqlite is required.');
  if (!options.mysqlUrl) throw new Error('--mysql-url or MYSQL_URL is required.');
  const result = await migrateSqliteToMysql({
    sqlitePath: options.sqlitePath,
    mysqlUrl: options.mysqlUrl,
    dryRun: options.dryRun,
    progress: (message) => console.log(message),
  });
  if (result.dryRun) console.log('Dry run complete; no Proxy data was written.');
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    mysqlUrl: process.env.MYSQL_URL,
    dryRun: false,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--sqlite') {
      options.sqlitePath = requireValue(args, ++index, arg);
    } else if (arg === '--mysql-url') {
      options.mysqlUrl = requireValue(args, ++index, arg);
    } else {
      throw new Error(`Unknown argument "${arg}".`);
    }
  }
  return options;
}

function requireValue(args: string[], index: number, option: string): string {
  const value = args[index]?.trim();
  if (!value) throw new Error(`${option} requires a non-empty value.`);
  return value;
}

function printUsage(): void {
  console.log(`Usage:
  npm run upgrade:sqlite-to-mysql -- --sqlite /path/to/proxy.sqlite --mysql-url mysql://user:password@host/database

Options:
  --sqlite <path>      Existing Proxy SQLite database (required)
  --mysql-url <url>    Empty MySQL 8 target; defaults to MYSQL_URL
  --dry-run            Validate source and target without creating schema or copying data
  --help, -h           Show this help`);
}

void main().catch((err: unknown) => {
  console.error(`SQLite to MySQL migration failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
