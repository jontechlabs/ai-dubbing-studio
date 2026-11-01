# Audio8-TTS Realistic

Le studio intègre **Audio8-TTS Realistic 0.6B · GGUF Q8_0**, en local, avec le moteur audio.cpp 0.9.1 déjà utilisé par Fish GGUF et Qwen3-TTS. Le modèle, le codec et le tokenizer sont réunis dans un fichier de **1 429 460 800 octets, soit 1,33 Gio**. Aucun service distant ni environnement Python supplémentaire n’est nécessaire après installation.

## Installation

1. Ouvrir **Modèles**, puis la carte **Audio8-TTS Realistic 0.6B · GGUF Q8_0**.
2. Vérifier l’espace nécessaire et disponible dans le dossier de stockage configuré. Le budget inclut le modèle manquant, l’archive du moteur, son extraction et une marge de 1 Gio. Il est recalculé avant tout téléchargement. Les fichiers sont vérifiés par taille et SHA-256 pendant l’installation.
3. Cliquer sur **Installer cette variante**. Le téléchargement est annulable et les fichiers complets vérifiés peuvent être réutilisés.
4. Dans **Doublage**, choisir Audio8. Pour la RTX 5060 Ti, sélectionner la carte dans les **périphériques Vulkan**. Les indices Vulkan et CUDA peuvent être différents. Le choix automatique privilégie le GPU dédié ; un périphérique explicite indisponible provoque une erreur, sans repli silencieux sur le CPU.

## Générer un essai

Choisir la référence de la réplique, d’un personnage, de sa bibliothèque validée ou d’un fichier importé. Audio8 exige la **transcription exacte de cette référence**, dans la langue réellement prononcée : la transcription japonaise pour un audio japonais, et française pour un audio français. Le bouton de transcription automatique existant peut la préparer ; la relire avant génération.

Le texte à prononcer reste la traduction française. La référence ne remplace jamais ce texte. Pour limiter le transfert d’accent japonais, privilégier une référence française propre et expressive. Une bonne intelligibilité ne garantit ni un accent natif ni une fidélité parfaite au personnage.

Les réglages de vitesse, graine, volume de sortie et qualité sont disponibles. Le profil standard conserve les valeurs du moteur épinglé : température 0,7, top-p 0,9, top-k 50. Les profils Stable et Expressif modifient l’échantillonnage ; ils ne sont pas des garanties de qualité. Ce chemin d’inférence ne dispose pas de commande fiable d’accent régional, d’humeur nommée ou de guide d’intonation : ces contrôles sont désactivés plutôt que transmis comme texte à prononcer.

La génération reste dans le panneau Doublage, avec le traitement courant puis le nouvel essai sélectionné. Tous les essais précédents sont conservés. Le moteur produit un WAV mono à 44,1 kHz ; le studio le convertit en PCM16 mono à 24 kHz, comme ses autres essais, pour l’édition, le mixage et l’export.

## Doublage par lot

Utiliser la configuration commune et les filtres habituels. Chaque réplique doit disposer d’une traduction et d’une référence transcrite. Le lot ouvre un serveur d’inférence privé sur l’interface locale, conserve le modèle entre les répliques, puis ferme son processus et libère sa mémoire à la fin, en cas d’erreur ou d’annulation. Les références par réplique ne sont pas mélangées. Forcer un nouveau doublage ajoute des essais.

## Choix du modèle et limites

La famille Realistic 0.6B annonce 23 langues, dont le français et le japonais. Le studio conserve ici son ensemble de langues de doublage existant. Le 0.1B vise surtout le chinois et l’anglais ; il n’est pas proposé comme moteur français. Une RTX de 16 Go est une cible raisonnable pour ce modèle compact, mais la taille du GGUF n’est pas une mesure de VRAM. La vitesse et la consommation sur RTX 5060 Ti restent à mesurer.

Les projets utilisant Audio8 sont enregistrés au **format 26** : conserver une sauvegarde pour les anciennes versions du studio. Les anciens projets restent lisibles. Les sous-titres, la vidéo source et les anciens essais ne sont pas réécrits par l’ajout du moteur.

## Sources et licence

- [Projet officiel Edge0-AI / Audio8](https://github.com/Edge0-AI/Audio8_TTS).
- [Modèle officiel Realistic 0.6B](https://huggingface.co/Edge0/Audio8-TTS-Realistic-0.6b), révision `925bbd4c2d8360af85f2594bf0205173fda853ba`, Apache 2.0.
- [Conversion audio-cpp GGUF](https://huggingface.co/audio-cpp/Audio8-TTS-Realistic-0.6b-GGUF), révision `b57015b9e916ede150f4b168b4b882be37ad723f`, Apache 2.0.
- [Contrat du moteur épinglé audio.cpp 0.9.1](https://github.com/0xShug0/audio.cpp/blob/v0.9.1/docs/community_models/audio8_tts.md).

La licence du modèle est téléchargée et vérifiée dans son dossier. Les poids se téléchargent uniquement sur demande. Les mesures des scripts de qualification sont des contrôles d’exécution et d’intelligibilité sur CPU ; elles ne constituent pas un classement perceptif ou un benchmark RTX.
