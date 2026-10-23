export type TravelerChoice = 'aether' | 'lumine';
export const TRAVELERS = {
  aether: {
    name: '空',
    portraitPath: 'rebuilt/portrait/Traveler_Male_Card_png_9d92cdb5d0fac307.webp',
    avatarPath: 'rebuilt/icon/UI_AvatarIcon_PlayerBoy_png_e1f7d678b7f043cd.webp',
  },
  lumine: {
    name: '荧',
    portraitPath: 'rebuilt/portrait/Traveler_Female_Card_png_41a2a79b25619ec1.webp',
    avatarPath: 'rebuilt/icon/UI_AvatarIcon_PlayerGirl_png_c49da2ad4af92f7c.webp',
  },
} as const;
export function normalizeTraveler(value: unknown): TravelerChoice | null {
  return value === 'aether' || value === 'lumine' ? value : null;
}
/** 固定角色空/荧可能是故事中的另一位亲属，只替换泛指玩家的旅行者。 */
export function isTravelerSpeaker(name: string | null | undefined): boolean {
  return ['traveler', 'traveller', '旅行者', '旅人'].includes((name || '').trim().toLowerCase());
}
