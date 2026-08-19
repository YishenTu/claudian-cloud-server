const BOOTSTRAP_FAILURE_MESSAGE = 'claudian-cloud-server bootstrap failure\n';

export function reportBootstrapFailure(write: (message: string) => void): void {
  write(BOOTSTRAP_FAILURE_MESSAGE);
}
