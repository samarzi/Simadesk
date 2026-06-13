/**
 * SimaDesk Official Logo Component
 * Возвращает HTML/SVG логотипа в фирменных цветах
 */
export const getLogoHTML = (size = 32): string => `
<div class="simadesk-logo" style="display: flex; align-items: center; gap: 10px; cursor: pointer;">
  <svg width="${size}" height="${size}" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect width="32" height="32" rx="8" fill="#D4F000"/>
    <path d="M8 17L13 22L24 11" stroke="#0D0D0D" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M20 26C24.4183 26 28 22.4183 28 18" stroke="#0D0D0D" stroke-width="1.5" stroke-opacity="0.3"/>
  </svg>
  <span style="
    font-family: 'Inter', system-ui, sans-serif; 
    font-weight: 800; 
    font-size: 20px; 
    letter-spacing: -0.03em; 
    color: #FFFFFF;
    line-height: 1;
  ">
    Sima<span style="color: #D4F000">Desk</span>
  </span>
</div>
`;