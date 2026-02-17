export type UiColorToken = string;

export interface UiColorTokens {
  accent: UiColorToken;
  border: UiColorToken;
  danger: UiColorToken;
  foreground: UiColorToken;
  muted: UiColorToken;
  success: UiColorToken;
}

export const colorTokens: UiColorTokens = {
  accent: "cyan",
  border: "gray",
  danger: "red",
  foreground: "white",
  muted: "gray",
  success: "green",
};
