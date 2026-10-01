// Outgoing mail: verification and password-reset links (docs/SPEC.md §8.2).

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/**
 * Development only: prints each message, link included, to the server's
 * output. A reset link signs whoever has it in, so production refuses to
 * start with this mailer (main.ts).
 */
export class ConsoleMailer implements Mailer {
  readonly sent: Mail[] = [];
  private readonly print: (line: string) => void;
  constructor(print: (line: string) => void = console.log) {
    this.print = print;
  }
  async send(mail: Mail): Promise<void> {
    this.sent.push(mail);
    this.print(`[mail] to ${mail.to}: ${mail.subject}\n       ${mail.text}`);
  }
}
