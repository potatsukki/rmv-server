import * as configService from '../config/config.service.js';

export async function getLandingPageContent() {
  return configService.getConfigValue<Record<string, unknown> | null>('landing_page_content', null);
}
