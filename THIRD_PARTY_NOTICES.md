# Üçüncü taraf bildirimleri

Bu proje aşağıdaki bileşenleri kullanır. Her biri kendi lisansı altındadır; **ana projenin ticari kullanım kısıtı
(`LICENSE`) bu bileşenlere uygulanmaz**, onların kendi koşulları geçerlidir.

## Birim verisi: the reference roster — source terms

`src/sim/data/troops.ts` (birim özellikleri ve yetenek açıklamaları), **the reference roster**'sindeki
birim tablolarından alınmıştır: docs/UNITS.md

- Lisans: **source terms (source terms)** (Host varsayılanı):
  https://creativecommons.org/licenses/by-sa/3.0/
- Atıf: "the reference roster contributors, Host".
- **Paylaşım koşulu (ShareAlike):** bu veriden türetilmiş veri source terms ile paylaşılmalıdır. Bu nedenle roster kaynaklı
  veri dosyaları, projenin ticari kısıtından **muaftır**; yalnızca source terms kurallarına (atıf + aynı lisansla paylaşım)
  tabidir.
- Değerler oyun ölçeğine bölenlerle indirgenmiş ve yetenekler özgün biçimde yeniden uygulanmıştır. Roster sanatı veya
  görselleri **kullanılmaz**; tüm çizimler `src/render/looks.ts` içindeki prosedürel, özgün tariflerdir.
- "the reference game" ilgili hak sahiplerinin ticari markasıdır; bu proje onlarla bağlantılı veya onaylı değildir.

## Çalışma zamanı bağımlılıkları

| Paket | Lisans | Kullanım |
|---|---|---|
| [PixiJS](https://github.com/pixijs/pixijs) v8 | MIT | 2B çizim |
| [PeerJS](https://github.com/peers/peerjs) 1.5.4 | MIT | WebRTC yedek bağlantısı |

## Geliştirme bağımlılıkları

[Vite](https://github.com/vitejs/vite) (MIT), [Vitest](https://github.com/vitest-dev/vitest) (MIT),
[TypeScript](https://github.com/microsoft/TypeScript) (Apache-2.0), `@types/node` (MIT). Ayrıca
[Wrangler](https://github.com/cloudflare/workers-sdk) (MIT/Apache-2.0) yalnızca `relay/` dağıtımı için kullanılır.

## Altyapı

İnternet rölesi bir Cloudflare Worker + Durable Object olarak çalışır (`relay/`); WebRTC yedek yolu PeerJS'in genel
sinyal sunucusunu kullanır. Bu hizmetler kendi kullanım şartlarına tabidir.

## Ses

Ses efektleri dosyasız WebAudio ile sentezlenir; harici ses dosyası yoktur.
