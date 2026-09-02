export const DEMO_SEED_KEY = 'demo-seed-v1';

export function shouldInitializeDemoData(marker: string | undefined) {
  return marker === undefined;
}

export function shouldSeedRsvpsForEvent(eventAlreadyExists: boolean) {
  return !eventAlreadyExists;
}
