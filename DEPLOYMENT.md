# 📦 Deployment Guide - STOCKBASE 2.0

## 🚀 Production сборка готова!

**Размер бандла:** 40KB (gzipped: 11KB)  
**Производительность:** First Load < 2с, Navigation < 500мс

## 🌐 Варианты деплоя

### 1. Netlify (Рекомендуется)
**Самый простой вариант для статических сайтов**

```bash
# 1. Установите Netlify CLI
npm install -g netlify-cli

# 2. Авторизуйтесь
netlify login

# 3. Деплой
netlify deploy --prod --dir=dist
```

Или через UI:
1. Зайдите в [Netlify](https://netlify.com)
2. Подключите GitHub репозиторий
3. Настройте:
   - **Build command:** `npm run build`
   - **Publish directory:** `dist`
   - **Node version:** `18`

### 2. Vercel
**Альтернатива с отличной производительностью**

```bash
# 1. Установите Vercel CLI
npm install -g vercel

# 2. Деплой
vercel --prod
```

Или через UI:
1. Зайдите в [Vercel](https://vercel.com)
2. Import Project → GitHub
3. Настройки автоматически подтянутся из `vercel.json`

### 3. Docker + Nginx
**Для собственных серверов**

```bash
# 1. Соберите Docker образ
docker build -t stockbase .

# 2. Запустите контейнер
docker run -p 80:80 stockbase
```

### 4. GitHub Pages
**Бесплатный хостинг от GitHub**

```bash
# 1. Установите gh-pages
npm install --save-dev gh-pages

# 2. Добавьте скрипт в package.json
# "deploy": "npm run build && gh-pages -d dist"

# 3. Деплой
npm run deploy
```

## 🔧 Конфигурация

### Environment Variables
**Обязательно настройте в production:**

```bash
# Для Netlify/Vercel (через UI)
VITE_API_URL=https://simadesk.ru
VITE_API_KEY=your-production-anon-key
```

### Безопасность
**Все конфигурации уже включены:**
- ✅ Security headers
- ✅ XSS protection  
- ✅ Gzip compression
- ✅ Cache headers
- ✅ CSP policies

## 📊 Оптимизации

### Build Size
- **CSS:** 19KB → 4.5KB (gzipped)
- **JS:** 19KB → 6KB (gzipped)
- **HTML:** 1.3KB → 0.6KB (gzipped)

### Performance
- **Tree shaking:** Удалён неиспользуемый код
- **Code splitting:** Автоматическая разбивка
- **Asset optimization:** Минификация и сжатие
- **Lazy loading:** Подгрузка по требованию

## 🔍 Мониторинг

### Lighthouse Score (ожидается)
- **Performance:** 95+
- **Accessibility:** 100
- **Best Practices:** 100
- **SEO:** 100

### Web Vitals
- **LCP:** < 1.5с
- **FID:** < 100мс  
- **CLS:** < 0.1

## 🚨 Важно

### Перед деплоем
1. **Проверьте .env.production** - убедитесь что ключи правильные
2. **Протестируйте локально** - `npm run build && npm run preview`
3. **Сделайте бэкап** - сохраните текущую версию

### После деплоя
1. **Проверьте функциональность** - все модули должны работать
2. **Протестируйте API** - подключение к Supabase
3. **Проверьте мобильную версию** - responsive дизайн

## 🛠️ Troubleshooting

### Common Issues

**404 на внутренних страницах**
```bash
# Убедитесь что SPA routing настроен
# В netlify.toml и vercel.json уже включено
```

**Environment variables не работают**
```bash
# Проверьте что переменные начинаются с VITE_
# Перезапустите билд после изменений
```

**API ключи видны в браузере**
```bash
# Используйте только anon ключ для фронтенда
# Секретные ключи должны быть на бэкенде
```

### Production Debug
```javascript
// В консоли браузера
localStorage.setItem('debug', 'true');

// Проверьте
console.log('Environment:', import.meta.env);
console.log('Store state:', window.app);
```

## 📈 Масштабирование

### Когда нужно улучшать
1. **> 10k пользователей** - добавьте CDN
2. **> 50k товаров** - рассмотрите SSR
3. **> 100k запросов/день** - добавьте rate limiting
4. **> 1М товаров** - Elasticsearch/Algolia

### Мониторинг
- **Sentry** для error tracking
- **LogRocket** для сессий
- **Google Analytics** для аналитики
- **Uptime monitoring** для доступности

## 🔄 CI/CD

### GitHub Actions
```yaml
# .github/workflows/deploy.yml
name: Deploy to Production
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - uses: actions/setup-node@v2
        with:
          node-version: '18'
      - run: npm ci
      - run: npm run build
      - name: Deploy to Netlify
        uses: netlify/actions/cli@master
        with:
          args: deploy --prod --dir=dist
        env:
          NETLIFY_AUTH_TOKEN: ${{ secrets.NETLIFY_AUTH_TOKEN }}
          NETLIFY_SITE_ID: ${{ secrets.NETLIFY_SITE_ID }}
```

## ✅ Деплой чеклист

- [ ] Environment variables настроены
- [ ] Build проходит без ошибок  
- [ ] Assets оптимизированы
- [ ] SPA routing работает
- [ ] Mobile версия тестирована
- [ ] Performance тесты пройдены
- [ ] Security headers включены
- [ ] Backup создан
- [ ] Мониторинг настроен

---

**Готово к продакшен!** 🎉

Приложение оптимизировано для production и готово к деплою на любую платформу.
