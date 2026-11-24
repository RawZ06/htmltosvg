# HTML to Design

Extension Firefox qui exporte le rendu actuel d'une page web en **SVG calqué**, un format ouvert importable dans :

- **Figma** : glisser-déposer le `.svg` sur le canvas
- **Sketch** : Fichier → Importer, ou glisser-déposer
- **Penpot**, **Lunacy**, **Affinity Designer**, **Illustrator**, **Inkscape**…

Le SVG produit garde une structure exploitable : un groupe nommé par élément (`header`, `div-card`, `button-submit`…), du **vrai texte éditable** et des formes vectorielles pour les fonds, bordures, dégradés et ombres.

## Installer (développement)

1. Ouvrir `about:debugging#/runtime/this-firefox` dans Firefox
2. **Charger un module complémentaire temporaire…** → choisir `extension/manifest.json`
3. Une icône apparaît dans la barre d'outils. Clic → **Zone visible** ou **Page entière**
4. Le fichier `titre-de-la-page-viewport-AAAAMMJJ-HHMM.svg` arrive dans les téléchargements

Au premier usage, Firefox peut demander l'accès aux sites (`<all_urls>`). Il sert à télécharger les images pour les intégrer au SVG sans être bloqué par le CORS.

## Publier une version

Pousser un tag `vX.Y.Z` déclenche la CI ([release.yml](.github/workflows/release.yml)). Elle :

1. met la version du tag dans `manifest.json`,
2. lance `web-ext lint`,
3. crée `htmltosvg-X.Y.Z.zip`,
4. publie une **release GitHub** avec le zip en pièce jointe.

```bash
git tag v0.2.0
```

```bash
git push origin v0.2.0
```

Le zip se télécharge depuis l'onglet *Releases* du dépôt. On peut aussi lancer le workflow à la main (*Actions → Release → Run workflow*) : le zip est alors disponible dans les artefacts du run, sans release.

**Installer le zip dans Firefox :**
- Firefox standard : `about:debugging` → *Charger un module complémentaire temporaire* → choisir le `.zip`. L'extension disparaît au redémarrage.
- Installation permanente : Firefox standard exige une extension signée par Mozilla. Deux options :
  - créer des clés API sur https://addons.mozilla.org/developers/addon/api/key/ et les ajouter en secrets du dépôt (`AMO_JWT_ISSUER`, `AMO_JWT_SECRET`). La CI produit alors aussi un `.xpi` signé (distribution « unlisted », non publiée sur le store), installable par glisser-déposer dans Firefox ;
  - ou utiliser Firefox Developer Edition / Nightly avec `xpinstall.signatures.required` à `false` dans `about:config`, puis installer le zip.

## Ce qui est géré (MVP statique)

| Élément | Rendu |
|---|---|
| Fond, `border-radius` (y compris par coin) | `rect` / `path` |
| Bordures uniformes (solid, dashed, dotted) ou par côté | contour ou rectangles |
| `box-shadow` (externes, multiples) | filtre d'ombre portée |
| `linear-gradient`, `radial-gradient` | dégradés SVG |
| `background-image: url()` (cover, contain, repeat) | `image` ou motif |
| Texte (police, graisse, italique, interlettrage, souligné, `text-transform`) | `text` avec une ligne par `tspan` |
| `img` (object-fit, coins arrondis), `canvas`, image courante d'une `video` | `image` intégrée en base64 |
| SVG inline, y compris les sprites `<use href="#…">` | SVG imbriqué, styles calculés recopiés |
| `overflow: hidden/auto` | masque (`clipPath`) |
| `opacity`, z-index (approximatif), Shadow DOM ouvert | ✓ |
| Champs de formulaire (texte, placeholder, checkbox, radio, select) | dessin simplifié |
| Couleurs modernes (`oklch`, `lab`, `color-mix`…) | converties en hex |

## Limites connues

- Pas d'auto-layout : tout est positionné en absolu
- `transform` (rotation, échelle) ignoré : la boîte est dessinée selon son rectangle englobant
- `::before` et `::after` non exportés (les icônes en font-icon via pseudo-élément manquent)
- `iframe` remplacées par un rectangle gris
- `text-shadow`, `filter`, `backdrop-filter`, `mix-blend-mode`, ombres internes : ignorés
- En mode « Page entière », les images en lazy-loading pas encore chargées sont absentes : faire défiler la page avant d'exporter
- Les polices doivent être installées localement dans l'outil de design. `system-ui` est mappé vers SF Pro Text (macOS), Segoe UI (Windows) ou Roboto

## Structure

```
extension/
  manifest.json      MV3, Firefox 128+
  background.js      injecte la capture, intègre les images, déclenche le téléchargement
  capture.js         parcours du DOM → SVG
  popup/             le bouton « Exporter »
test/
  sample.html        page de test couvrant les cas gérés
  harness.html       compare la page et le SVG côte à côte
```

Pour tester la capture sans recharger l'extension :

```bash
python3 -m http.server 8765
```

puis ouvrir http://localhost:8765/test/harness.html (à gauche la page, à droite le SVG généré).
