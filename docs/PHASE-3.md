# Phase 3 — audio, fluidité et mises à jour

## Séparer voix, musique et effets

Ouvrez **Audio** après l’import vidéo. Cliquez sur **Installer Bandit** : le studio installe Python et ses bibliothèques dans son espace de données, puis télécharge les poids multilingues de 447 Mo. Le téléchargement et son empreinte SHA-256 sont vérifiés. Prévoir environ 2 Go en mode CPU et davantage avec CUDA. Cette installation utilise Internet ; la séparation des médias reste locale.

Depuis **v0.3.2**, les poids sont téléchargés depuis un miroir GitHub du checkpoint officiel inchangé, avec le lien public Zenodo comme source de repli. La licence CC-BY-SA 4.0, les auteurs, le DOI et les empreintes sont inclus dans la notice du modèle. Le fichier doit avoir exactement la taille et l’empreinte attendues avant d’être installé. Les erreurs temporaires reçoivent au maximum deux tentatives par source ; un refus 403 passe directement à la suivante.

Si une ancienne tentative a échoué avec **403 Forbidden** au téléchargement du modèle, mettez le studio à jour vers v0.3.2, puis ouvrez **Traitements → Réessayer** sur cette tentative. La vérification réutilise Python et les dépendances lorsqu’ils sont complets et correspondent au choix CPU/CUDA enregistré. Les archives et modèles déjà présents ne sont réutilisés qu’après validation de leur taille et de leur SHA-256. Les logs indiquent la source utilisée et la réutilisation des fichiers. Un téléchargement partiel est supprimé, puis recommencé ; la reprise à partir d’un offset n’est pas implémentée.

Pour un GPU NVIDIA compatible, cochez la variante CUDA lors de l’installation. Depuis **v0.3.1**, le studio utilise PyTorch 2.8 avec **CUDA 12.8**, qui prend en charge Blackwell, dont la RTX 5060 Ti. [Versions officielles PyTorch](https://pytorch.org/get-started/previous-versions/) · [Support Blackwell](https://pytorch.org/blog/pytorch-2-7/).

Pour remplacer une installation CPU ou l’ancienne variante CUDA 12.6, ouvrez **Audio → Modifier ou réparer l’installation Bandit**, cochez **Installer la variante NVIDIA CUDA 12.8**, puis cliquez sur **Réinstaller Bandit**. Les composants requis sont installés ou réutilisés après vérification ; les projets et pistes déjà séparées restent conservés. Après réussite, fermez les traitements et rouvrez Audio pour actualiser les processeurs disponibles.

Le studio teste une opération CUDA avant de proposer un GPU. Une carte détectée dont les kernels ne fonctionnent pas affiche un avertissement et n’est pas sélectionnée automatiquement. Ce petit test ne remplace pas un essai de séparation complet. Choisissez **CPU**, **Automatique**, ou un device CUDA précis. Bandit ne prend pas en charge DirectML/AMD/Intel/Metal dans cette intégration : leur présence dans les réglages graphiques du lecteur ne leur donne pas un backend d’inférence CUDA.

Cliquez sur **Séparer voix / musique / effets**. Les traitements affichent extraction, séparation, progression et logs. La pause s’applique entre deux segments ; le segment en cours peut continuer quelques instants. Annuler arrête le worker. Un échec ne remplace pas les pistes précédentes ; **Réessayer** crée une nouvelle tentative sur le même média/device, si ce contexte est toujours ouvert.

Sur CPU, un film complet peut être très long à traiter. Le calcul utilise des fenêtres de taille bornée, sans charger toute la bande-son en mémoire. Les trois WAV sont enregistrés uniquement après réussite et apparaissent dans la timeline. La séparation est une estimation : voix résiduelles, fuite entre pistes et artefacts restent possibles. Le premier essai de cette version utilise un extrait synthétique ; il ne prouve pas la qualité sur toutes les langues et bandes-son.

## Écouter et exporter

Le mixeur **Audio** contient l’original, les voix, la musique et les effets. **M** coupe une piste, **S** l’écoute en solo ; plusieurs solos peuvent être actifs. Les niveaux de piste vont de 0 à 200 %, avec le volume du lecteur comme niveau général. La lecture vidéo synchronise les stems. Après une séparation, l’original est coupé pour éviter de doubler la bande-son. Les réglages sont sauvegardés dans le projet.

Le bouton de téléchargement sur chaque stem exporte son WAV séparé. Les sorties des anciennes tentatives restent conservées dans `stems/`, avec leur provenance dans le projet ; elles ne sont pas écrasées par une nouvelle séparation. L’export du mix final reste prévu en phase 7.

Les anciens projets au format 1 s’ouvrent normalement. L’ajout de stems passe le projet au **format 2**. Une ancienne version du studio ne pourra plus ouvrir ce projet ; conservez la sauvegarde du dossier si vous souhaitez revenir en arrière. L’annulation en session peut restaurer le projet précédent.

## Lecteur lent et GPU

Un iGPU n’est pas forcément la cause d’une lecture lente. Le codec, la définition, les images clés, le pilote, la session distante et la charge du logiciel peuvent aussi intervenir. Cette version évite de recalculer les blocs de timeline à chaque actualisation de lecture et utilise une recherche indexée des sous-titres actifs.

Dans **Audio → Préparer un aperçu fluide**, le studio crée un H.264 limité à 720p/30 images par seconde, sans agrandir les petites vidéos, avec une image clé toutes les 30 images. Cela réduit le décodage et accélère les déplacements ; l’original reste conservé. Les nouveaux imports trop grands reçoivent cet aperçu automatiquement.

Dans **Paramètres → GPU et accélération**, choisissez Automatique, Économie d’énergie ou Haute performance, puis redémarrez l’application. La préférence ne concerne que l’exécutable du studio. Le GPU effectif de WebView2 et du décodeur reste choisi par Windows et le pilote ; ce n’est pas une sélection garantie d’adaptateur par identifiant. Le bouton **Ouvrir les réglages graphiques Windows** et le chemin affiché permettent de régler cette préférence dans Windows. [Documentation Microsoft](https://support.microsoft.com/en-us/windows/hardware/display-graphics/optimizations-for-windowed-games-in-windows-11).

Les compteurs **Fluidité du lecteur** affichent la résolution réellement lue et les images perdues depuis le chargement. Comparez l’avant/après avec le même extrait pour vérifier si l’aperçu léger ou la préférence GPU aide. Ces compteurs ne déterminent pas à eux seuls la cause du ralentissement.

Sur une machine avec Ryzen 7 5700G et RTX 5060 Ti, dont l’écran est connecté à la carte mère, commencez par **Haute performance** et vérifiez que les options graphiques Windows associent ce choix à la RTX. Windows peut présenter un rendu effectué sur la carte dédiée via l’iGPU ; ce chemin dépend des pilotes. Le branchement ne prouve pas la cause d’une lecture lente. Comparer le même extrait avec l’écran connecté directement à la RTX peut aider à isoler le chemin d’affichage. [Fonctionnement des systèmes hybrides Windows](https://learn.microsoft.com/en-us/windows-hardware/drivers/display/using-cross-adapter-resources-in-a-hybrid-system).

## Mises à jour dans l’application

Depuis v0.2.x, il faut installer **v0.3.2 manuellement une première fois** depuis GitHub. Depuis v0.3.0, **Paramètres → Rechercher une mise à jour** propose ce correctif et les versions suivantes. La vérification au démarrage peut être désactivée.

Lorsqu’une version est proposée, cliquez sur **Télécharger la mise à jour**. La signature Tauri est vérifiée avant l’installation. Puis cliquez sur **Installer et redémarrer** ; le studio sauvegarde le projet et attend la fin ou l’annulation des traitements. Aucun média n’est envoyé pour vérifier les versions.

Les mises à jour utilisent l’installeur NSIS pour l’utilisateur courant. Depuis un ZIP portable, ce mécanisme installe une application utilisateur ; téléchargez plutôt le nouveau ZIP si vous souhaitez conserver un usage par extraction. La signature de mise à jour garantit l’origine du paquet ; elle ne remplace pas un certificat Windows Authenticode. Les exécutables restent des builds de développement non signés par un certificat Windows.

## Étapes restantes

La phase 3 est implémentée. Il reste **4 phases** :

1. Phase 4 : personnages, références vocales et assignation des répliques.
2. Phase 5 : premier moteur TTS, génération par ligne, variantes et validation.
3. Phase 6 : autres moteurs et gestionnaire général des modèles.
4. Phase 7 : mix final, export MKV et langues multiples.

## English quick guide

Audio installs the optional Bandit runtime/model, selects a detected CPU/CUDA device, starts local speech/music/effects separation, and provides persistent mute/solo/gain with individual WAV exports. Pause is applied between windows; failed/cancelled attempts preserve existing tracks. Adding stems uses project format 2, while older format 1 projects remain readable.

Version 0.3.1 installs the CUDA 12.8 PyTorch wheels for NVIDIA GPUs, including Blackwell/RTX 50. Modify or repair the Bandit installation to replace a CPU or older CUDA environment. Device discovery executes a small CUDA kernel; unusable devices are reported and excluded from automatic selection. Full CUDA Bandit inference remains unqualified on the development host.

Version 0.3.2 downloads the unchanged checkpoint from the attributed GitHub mirror, with Zenodo fallback, bounded transient retries, exact-size and SHA-256 verification. Retry a failed model installation from Processing after updating; a complete matching dependency environment and verified cached files are reused. Partial downloads restart from zero.

Prepare a smooth preview for slow playback and compare resolution/dropped-frame counters in Settings. Windows renderer GPU preference requires restart and remains subject to Windows/driver selection; it is separate from inference device selection. Install 0.3.0 manually once, then use Settings to check, download a signature-verified update, and install/restart. A portable package’s in-app update uses the current-user installer.
