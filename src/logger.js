import pino from 'pino';

export function createLogger(level = 'info') {
  const options = {
    level,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label })
    },
    redact: {
      paths: [
        'config.imap.auth.pass',
        'config.imap.auth.oauth2.clientSecret',
        'config.imap.auth.oauth2.refreshToken',
        'config.imap.auth.oauth2.accessToken',
        'config.imapPass',
        'config.dropbox.accessToken',
        'config.dropbox.refreshToken',
        'config.dropbox.appSecret',
        'config.adminAuth.username',
        'config.adminAuth.passwordHash',
        'adminPassword',
        'dropboxAccessToken',
        '*.clientSecret',
        '*.refreshToken',
        '*.accessToken',
        '*.pass'
      ],
      censor: '[REDACTED]'
    }
  };

  if (process.env.NODE_ENV === 'production') {
    return pino(options);
  }

  const transport = pino.transport({
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname'
    }
  });

  return pino(options, transport);
}
