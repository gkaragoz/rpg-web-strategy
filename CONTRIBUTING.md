# Katkıda bulunma

Projeye katkı memnuniyetle karşılanır: hata düzeltmeleri, denge/oynanış iyileştirmeleri, çeviriler, test ve
dokümantasyon. Proje **kaynağı açık ama ticari kullanıma kapalıdır** (bkz. [`LICENSE`](LICENSE), PolyForm
Noncommercial 1.0.0 + ek şartlar). Katkın resmi projeye gider; ticari kullanım hakkı proje sahibindedir.

## Başlamadan önce

1. **Lisans ve CLA'yı oku:** [`LICENSE`](LICENSE), [`CLA.md`](CLA.md). Pull request açarak ve şablondaki CLA kutusunu
   işaretleyerek CLA'yı kabul etmiş olursun. CLA'sız PR birleştirilmez.
2. **Önce bir issue aç** (özellikle büyük değişikliklerde): ne yapmak istediğini yaz, onay al, sonra çalış. Küçük
   hata düzeltmeleri için doğrudan PR açabilirsin.
3. Başkasının işini (kod, görsel, ses, veri) lisansını belirtmeden ekleme. Roster kaynaklı birim verisi source terms'dır
   ([`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)).

## Geliştirme

```bash
git clone https://github.com/gkaragoz/rpg-web-strategy.git
cd rpg-web-strategy
npm install
npm run dev       # http://localhost:5173
npm run check     # tsc --noEmit + testler (PR öncesi geçmeli)
```

- **Kod stili:** mevcut dosyaların stiline uy (TypeScript, katı tipler, kısa Türkçe açıklayıcı yorumlar, arayüz metinleri
  Türkçe). Gereksiz bağımlılık ekleme; yeni bağımlılık için issue'da gerekçe yaz (sabit sürüm).
- **Simülasyon (`src/sim`) deterministiktir:** çevrimiçi mod herkesin aynı sonucu üretmesine dayanır. `Math.random`,
  `Date.now`, `performance.now` gibi belirsiz kaynakları sim yoluna sokma; rastgelelik için `Mulberry` kullan.
  Sim'i değiştiren PR'larda `src/sim/__tests__/determinism.test.ts` ve `net*.test.ts` geçmeli.
- **Testler:** her hata düzeltmesi/özellik için mümkünse test ekle (`src/sim/__tests__`).
- **Çevrimiçi/ağ kodu** (`src/net`, `src/app/online`, `relay/`): protokolü değiştirirsen `PROTOCOL` sürümünü artır.
- **Mobil:** arayüz değişikliklerini dar ekranda (≈ 380 px, dikey ve yatay) ve dokunmatikle de dene.

## Pull request süreci

1. Fork → dal aç (`fix/...`, `feat/...`) → küçük, odaklı commit'ler.
2. `npm run check` temiz olmalı.
3. PR şablonunu doldur; **CLA kutusunu işaretle**.
4. İnceleme sonrası birleştirilir. Proje sahibi katkıyı değiştirebilir veya reddedebilir.

## Güvenlik

Güvenlik açığı bulursan herkese açık issue açma; GitHub profilinden proje sahibine özel olarak ulaş.

## Davranış

Saygılı ol. Kişisel saldırı, taciz ve ayrımcılık kabul edilmez; bu tür davranışlar katkı hakkını sona erdirebilir.
