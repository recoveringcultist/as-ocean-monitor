export const strings = {
  CANCELLED: "Cancelled. Send /start to start",
  COMING_SOON: "coming soon",
  ENTER_WALLET: "What's your wallet address?",
  HELP: "try sending command /start",
  NO_WALLET: "No wallet linked",
  WALLET_INVALID: "Wallet invalid",
  WALLET_UNLINKED: "Wallet unlinked",
  WALLET_UPDATED: "Wallet updated",
};

export function getString(key) {
  if (strings[key]) {
    return strings[key];
  }
  throw new Error(`unknown string ${key}`);
}
