# LatentSync 1.5 / 1.6 — retouches locales par dialogue

Depuis **v0.17.0**, le studio intègre une adaptation du cœur de [ShmuelRonen/ComfyUI-LatentSyncWrapper](https://github.com/ShmuelRonen/ComfyUI-LatentSyncWrapper), sans serveur ni installation séparée de ComfyUI. MuseTalk reste disponible.

## Choisir et installer

1. Générez et sélectionnez un essai de doublage pour une réplique.
2. Ouvrez **Régénérer → Retoucher les lèvres (vidéo)**. Le même catalogue est accessible dans **Modèles**.
3. Choisissez **LatentSync 1.5 · 256 px · ShmuelRonen** ou **LatentSync 1.6 · 512 px · ShmuelRonen**.
4. L’application affiche l’espace disponible et l’espace supplémentaire estimé : poids manquants, archives de dépendances manquantes, extraction et marge. **Installer LatentSync** reste bloqué si l’espace manque. Actualisez après avoir libéré de l’espace ; le traitement natif vérifie de nouveau avant tout téléchargement.
5. Téléchargez les composants vérifiés. Les deux versions partagent leur environnement Python/CUDA et les composants audio/VAE ; leurs poids UNet sont distincts, environ **5,07 Go par version**, plus environ **0,5 Go** communs. Le budget affiché inclut aussi le runtime CUDA, ses archives et une marge de 2 Gio. Il dépend des fichiers déjà installés.
6. Choisissez explicitement la **RTX 5060 Ti** dans le périphérique de génération.

![Configuration LatentSync](screenshots/latentsync-profiles-fr.png)

*Interface React réelle avec séquence synthétique de démonstration et commandes natives simulées. La capacité disque et le GPU de cette capture sont simulés ; ce n’est pas une mesure de génération sur RTX.*

| Moteur | Résolution du visage | Mémoire annoncée en amont | Profil du studio |
| --- | --- | --- | --- |
| LatentSync 1.5 | 256 × 256 | 8 Go minimum | Fenêtres de 16 images, puis 8/4 si OOM |
| LatentSync 1.6 | 512 × 512 | 18 Go minimum | Candidat 16 Go : fenêtres de 8 images, puis 4 si OOM |

Les chiffres en amont viennent du [projet officiel](https://github.com/bytedance/LatentSync#-inference). **Le wrapper seul ne garantit pas l’absence d’OOM.** Le studio limite son budget PyTorch à au plus 14 Gio, conserve une réserve pour l’interface et le décodage vidéo, exécute la guidance conditionnelle et non conditionnelle séparément et décharge le VAE avant de charger l’UNet sur le GPU. Encodage et décodage VAE s’effectuent image par image, en FP32 ; l’UNet utilise FP16. L’analyse Whisper audio utilise le CPU. Un échec mémoire réduit la fenêtre sur **le même GPU** ; aucun repli de l’inférence vidéo sur CPU n’est effectué. Le processus se termine et libère ses allocations à la fin, en cas d’erreur ou d’annulation.

Le profil 1.6 modifie le contexte temporel par rapport à l’inférence officielle. La continuité et la fidélité doivent être examinées sur vos plans. **La génération complète avec les poids préentraînés, la consommation maximale et la vitesse sur RTX 5060 Ti 16 Go n’ont pas été mesurées sur la machine de développement.**

## Cadrage et réglages

Dessinez le visage entier, avec les yeux, le nez et le menton, puis ajustez le masque de bouche. Si nécessaire, activez le déplacement simple entre le début et la fin pour un mouvement régulier. Un changement de plan ou un mouvement important exige un autre cadrage ou des répliques plus courtes. Le masque utilisateur est combiné au masque utilisé pendant l’entraînement ; les zones extérieures ne sont pas fusionnées.

LatentSync cible surtout des **visages humains de face**. Pour les animes, l’usage est **expérimental** : les profils Anime/Personne filmée règlent la fusion, sans transformer le modèle en moteur spécialisé anime. Comparez les contours, les dents et les couleurs avant activation ; essayez MuseTalk si le résultat convient mieux.

- **Étapes de diffusion** : 10–50, 20 par défaut ; davantage d’étapes augmente le temps de calcul.
- **Intensité de synchronisation** : 1–3, 1,5 par défaut.
- **Graine**, intensité de fusion, douceur du masque et périphérique sont enregistrés dans chaque variante.
- Durée : **0,2 à 120 secondes** par séquence LatentSync, **25 images/s**. MuseTalk garde sa limite de 10 secondes. Une tâche est limitée à deux heures.

## Vidéo principale conservée et lecture

Le studio extrait seulement l’intervalle du doublage sélectionné, à sa position et à sa durée audibles, dans le dossier temporaire du projet. La durée est arrondie vers le bas au pas vidéo de 40 ms, sans étendre le traitement au reste du film. Le worker reçoit ces images de visage et cet audio uniquement ; il ne reçoit pas le chemin de la vidéo principale.

Le résultat est une séquence indépendante `generations/lips-<id>.mp4`. Elle est désactivée au départ. Comparez **Avant / Après** avec le doublage, puis choisissez **Activer pour la lecture et l’export**. Plusieurs essais sont conservés. Ctrl+Z annule l’activation. Un déplacement, un changement de durée ou une édition du doublage rend la variante périmée ; il faut la régénérer.

Pendant la lecture, la vidéo principale continue à jouer et fournit l’horloge et le son. Au maximum deux décodeurs muets sont utilisés pour les retouches : la séquence active et la suivante, préchargée jusqu’à cinq secondes avant son début. Le décodeur préchargé est conservé lors de la transition. Pauses, déplacements et vitesses sont suivis par les retouches sans changer la source du lecteur principal. Une séquence absente ou pas encore prête laisse apparaître l’original ; le film continue. Les retouches restent à 25 images/s, même si le film original a une fréquence supérieure. La fluidité sur de très grosses vidéos dépend aussi du disque, du codec et du matériel ; aucun benchmark 4K/RTX n’a été réalisé.

L’export MKV crée un **nouveau fichier** et compose les seules variantes activées aux intervalles correspondants. L’original du projet et le fichier vidéo importé ne sont jamais réécrits. Sans retouche activée, le chemin d’export vidéo existant reste disponible.

Les variantes LatentSync utilisent le format de projet **13**. Conservez une copie du projet si vous souhaitez l’ouvrir dans une ancienne version. Les projets existants et les variantes MuseTalk restent pris en charge.

## Provenance et vérifications

- Wrapper fixé à `360d5283d7276aee68b4237b1387e594e4ce640e` ; source officielle fixée à `a229c3948406bc2cf6eaf4873e662e70c6a04746`.
- Poids officiels ByteDance : révisions, tailles et SHA-256 dans `workers/latentsync-model.json`. Le téléchargement et la génération vérifient ces empreintes. Aucun poids n’est inclus dans le setup ou les sources.
- Sources neuronales et licence dans `workers/vendor/latentsync/`. L’adaptateur utilise le chargement strict : aucune couche manquante remplacée silencieusement par des poids aléatoires, aucun VAE de secours aléatoire.
- Les en-têtes des deux vrais checkpoints ont été lus depuis les dépôts officiels : les **1 246 noms et dimensions** correspondent à l’architecture embarquée pour chaque version. Diagnostics CPU avec de vrais petits modèles Whisper/UNet temporel/VAE, guidance séquentielle, fenêtres DDIM et chargement strict sous chemin Unicode. Ceci ne valide pas la qualité du rendu complet ni son utilisation VRAM.
- Les tests FFmpeg vérifient le cadrage 512 px, une séquence indépendante et un export où seuls les intervalles choisis changent, avec empreinte du fichier source identique avant/après. Les tests navigateur vérifient le préchargement et la conservation du lecteur principal. [Résultats détaillés](../VALIDATION.md).
