export class WorkspaceExportLease {
  private activeLeaseId: string | null = null;

  get id(): string | null {
    return this.activeLeaseId;
  }

  get active(): boolean {
    return this.activeLeaseId !== null;
  }

  acquire(leaseId: string, blockedByOtherOperation: boolean): boolean {
    if (!leaseId || blockedByOtherOperation || this.activeLeaseId !== null) return false;
    this.activeLeaseId = leaseId;
    return true;
  }

  release(leaseId: string): boolean {
    if (this.activeLeaseId !== leaseId) return false;
    this.activeLeaseId = null;
    return true;
  }
}
