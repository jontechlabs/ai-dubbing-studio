# AI Dubbing Studio — phases 1–2

[Version anglaise et captures de l’interface](README.md) · [Téléchargements Windows](https://github.com/jontechlabs/ai-dubbing-studio/releases/tag/v0.2.0)

Studio desktop local de travail texte, voix et vidéo. Tauri 2, React, TypeScript strict et Rust.

## Utiliser le studio

La version Windows contient FFmpeg et FFprobe. Aucun modèle IA n'est installé ou exécuté dans cette phase.

1. Importer une vidéo et choisir la langue source, la langue cible et la piste audio.
2. Choisir le dossier parent du projet. Le studio crée un dossier `Nom.dubproject` et copie le média.
3. Importer un SRT original et/ou traduit depuis la colonne Dialogues.
4. Sélectionner une réplique pour positionner le lecteur et la timeline.
5. Éditer le sous-titre ou son texte de prononciation. Le projet se sauvegarde automatiquement.
6. Réouvrir le dossier `.dubproject` depuis le bouton Ouvrir un projet.

L'exemple fourni utilise une vidéo et un son synthétiques. Il ne contient pas de voix doublée.

## Fonctions présentes

- Trois zones redimensionnables : dialogues, lecteur et timeline.
- Import MKV, MP4, MOV, AVI et WEBM, analyse FFprobe et sélection audio.
- Copie du média original ; proxy H.264/AAC pour les fichiers incompatibles ou les pistes multiples.
- Import/export SRT UTF-8, textes multilignes et sélection des pistes texte du MKV pour le SRT original ou traduit. Les pistes bitmap nécessitent un OCR.
- Associations bilingues conservatrices par timings. Les correspondances ambiguës restent distinctes et signalées.
- Texte original, traduction et surcharge TTS séparés.
- Lecture de réplique, boucle avec marges configurables, volume, plein écran et navigation.
- Forme d’onde réelle de la piste audio choisie, calcul local, cache, progression et annulation.
- Édition des timecodes pour un SRT ou les deux, déplacement et redimensionnement des blocs, aimantation avec Maj, zoom et hauteur des pistes.
- Division à la tête de lecture et fusion avec la réplique suivante ; les SRT exportés reflètent les changements.
- Calage automatique des deux SRT avec choix de référence, estimation de décalage/dérive, associations multiples et aperçu avant application.
- Autosave, sauvegarde précédente, récupération d'une écriture interrompue, undo/redo en session.
- Jobs d'import annulables, logs, relance et détection des jobs interrompus au redémarrage. La zone Traitements s’ouvre automatiquement à la création ; le lecteur affiche un chargement jusqu’à la fin de l’import et la disponibilité de la première image.
- Interface FR/EN, thème sombre/clair et diagnostic exportable.

La phase 2 est disponible. Le calage compare les timings et refuse les propositions ambiguës ; les blocs non associés restent inchangés. Il ne recale pas encore les sous-titres sur les voix. Consultez le [guide détaillé de la phase 2](docs/PHASE-2.md). La séparation, la transcription et les voix IA sont prévues dans les phases suivantes. Le conteneur MKV et les exports audio finaux arriveront en phase 7.

![Studio de la phase 2](docs/screenshots/studio.png)

![Aperçu du calage automatique](docs/screenshots/alignment.png)

Captures de l’interface réelle en aperçu navigateur, avec média synthétique.

## Raccourcis

Espace : lecture/pause. O : lire l'original de la réplique. J : retour temporel. K : pause. L : lecture puis accélération. Ctrl+S : sauvegarde. Ctrl+Z / Ctrl+Y : undo/redo. Les raccourcis de transport restent inactifs pendant une saisie.

## Développement

Prérequis : Node compatible avec Vite, pnpm, Rust stable, dépendances Tauri de la plateforme. Sous Windows : compilateur MSVC, SDK Windows et WebView2. Références : https://v2.tauri.app/start/prerequisites/ et https://v2.tauri.app/distribute/windows-installer/.

```sh
pnpm install --frozen-lockfile
powershell -NoProfile -File scripts/prepare-ffmpeg.ps1
pnpm desktop
```

Les exécutables FFmpeg/FFprobe sont recherchés dans les ressources de l'application, `src-tauri/binaries`, puis le PATH. Les exécutables ne sont pas conservés dans Git : le script de préparation télécharge l’archive Windows verrouillée et vérifie son SHA-256. Pour Linux/macOS, fournir les exécutables natifs de la cible. Les binaires Windows distribués ne conviennent pas à ces systèmes.

```sh
pnpm build
pnpm test
pnpm lint
pnpm format:check
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml --check
pnpm desktop:build
powershell -NoProfile -File scripts/package-windows.ps1
```

Les tests de parcours utilisent Chrome et gèrent automatiquement leur serveur Vite : `pnpm test:e2e`. L'aperçu navigateur stocke ses projets et médias dans IndexedDB. Il permet de vérifier l'interface ; l'analyse FFprobe et les dossiers portables restent des fonctions desktop. L'export JSON du navigateur ne contient pas la vidéo.

## Architecture et données

`src/domain` contient les calculs et contrats métier. `src/services/bridge.ts` est la frontière IPC. `src/components` assemble le studio ; aucun composant ne construit une commande FFmpeg ou IA. `src-tauri/src` contient les services de projet, média, sous-titres et jobs. Les composants de composition peuvent dépasser 100 lignes de JSX ; la logique de traitement reste dans des fonctions et modules séparés.

`project.json` est la source de vérité. Les chemins des assets sont relatifs, les timings en millisecondes entières et les identifiants stables. Les fichiers vidéo d'origine ne sont pas modifiés. Le projet contient les documents source/cible et leurs associations. Un changement de traduction ne modifie pas automatiquement une surcharge TTS.

La version initiale du format est 1. Les formats inconnus sont refusés sans réécriture. Les migrations de futurs formats seront ajoutées explicitement. `recovery/pending.json` permet de reprendre une sauvegarde interrompue ; `recovery/previous.json` conserve la version précédente. Une génération future restera un fichier distinct avec sa provenance et ne sera pas écrasée par un job.

Les projets déplacés s'ouvrent depuis leur nouveau dossier. Les médias et caches doivent rester dans le dossier projet. La modification concurrente par deux instances n'est pas prise en charge dans cette version.

## Données locales

L'application ne dispose d'aucun provider cloud et n'envoie pas les médias sur Internet. Les préférences d'interface restent locales. Les diagnostics peuvent contenir les chemins choisis et les arguments FFmpeg ; leur export est déclenché par l'utilisateur.

Les futurs moteurs utiliseront des workers isolés. Les contrats initiaux se trouvent dans `src/domain/providers.ts` et le catalogue initial `resources/models.json` est volontairement vide.

## Distribution et dépendances

Les builds Windows incluent FFmpeg/FFprobe provenant de Gyan, distribué sous GPLv3 ; consulter `THIRD-PARTY-NOTICES.txt` et les licences incluses. Les versions et empreintes de téléchargement sont conservées dans `resources/toolchain.json`. Les dépendances JS et Rust sont verrouillées par `pnpm-lock.yaml` et `Cargo.lock`.

Le build de cette phase est un build de développement sans certificat de signature commerciale. Les contrôles Windows peuvent empêcher l'exécution de binaires non signés. La compilation peut également être effectuée depuis Linux avec cargo-xwin selon la documentation Tauri, sans modifier les protections de Windows.
