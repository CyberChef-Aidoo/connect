export class UploadSlots {
  private global = 0;
  private readonly perUser = new Map<string, number>();

  constructor(
    private readonly perUserLimit: number,
    private readonly globalLimit: number,
  ) {}

  tryAcquire(userId: string): boolean {
    const mine = this.perUser.get(userId) ?? 0;
    if (mine >= this.perUserLimit || this.global >= this.globalLimit) return false;
    this.perUser.set(userId, mine + 1);
    this.global += 1;
    return true;
  }

  release(userId: string): void {
    const mine = this.perUser.get(userId) ?? 0;
    if (mine <= 1) this.perUser.delete(userId);
    else this.perUser.set(userId, mine - 1);
    this.global = Math.max(0, this.global - 1);
  }
}
