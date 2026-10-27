# Bibliothèque vocale par personnage · v0.30

Le studio peut conserver plusieurs extraits d'un personnage, en tirer des phrases françaises, puis utiliser les phrases **écoutées et validées** comme références. La réplique japonaise peut fournir un guide distinct pour le jeu. Tout fonctionne en local avec VoxCPM2 déjà installé ; aucune nouvelle conversion vidéo ni suppression d'essai n'est nécessaire.

## Préparer les voix

1. Ouvrez **Personnages**, choisissez le personnage et dépliez **Bibliothèque vocale du personnage**.
2. Ajoutez des références existantes ou des répliques assignées à ce personnage. Réglez le début/la fin de chaque extrait ; pour une réplique, choisissez sa piste. Utilisez de la parole claire avec peu de musique, de réverbération ou de bruit. Les montages locaux de piste sont respectés, avant le volume et le bouton muet de la piste.
3. Assemblez **5 à 20 secondes au total**, avec 16 extraits au maximum. Une nouvelle source WAV mono 24 kHz est créée, avec provenance et empreinte ; les fichiers d'origine restent intacts.
4. Choisissez les phrases françaises, leur humeur, le périphérique VoxCPM2, la graine et la qualité. Huit phrases sont proposées ; vous pouvez les éditer et en ajouter, avec 12 phrases au plus par lot. L'accent français est une consigne, pas une garantie : écartez les références dont le rendu reste incorrect.
5. Lancez le lot. Le modèle reste chargé entre les phrases, puis son processus est fermé à la fin, à l'annulation ou en cas d'erreur. Une reprise garde les phrases déjà achevées et ajoute les manquantes avec de nouveaux fichiers.

## Écouter et valider

Chaque phrase commence **À valider**. Écoutez la diction, l'accent, le timbre et l'interprétation ; corrigez le **texte réellement prononcé** s'il diffère du texte demandé. Vous pouvez valider, retirer la validation, écarter, et choisir une référence validée par défaut.

Modifier la transcription retire la validation et l'éventuel défaut. Les phrases écartées restent consultables. La validation ne supprime ni ne réécrit le WAV. Les opérations sont sauvegardées et annulables ; les prises de doublage antérieures restent conservées.

![Phrase française validée](screenshots/voice-library-approved-fr.png)

*Capture du véritable écran React avec projet de démonstration et fichiers audio de test ; aucune qualification de qualité vocale ou de GPU n'est déduite de cette capture.*

## Doubler avec cette bibliothèque

Dans **Doublage → Référence vocale**, choisissez **Bibliothèque validée du personnage**. Seules les phrases validées sont proposées. Pour une réplique, vous pouvez choisir une phrase précise ou le défaut. En lot, chaque personnage utilise son propre défaut validé ; une réplique sans référence utilisable est signalée avant génération.

VoxCPM2 sélectionne alors, sans guide distinct, la continuation fidèle : l'audio français et sa transcription exacte conditionnent le modèle. Les commandes séparées d'accent/humeur sont désactivées dans ce mode. Choisissez donc une phrase française qui contient déjà l'interprétation souhaitée.

Les autres moteurs peuvent utiliser les références validées via leurs modes de clonage habituels ; le **guide distinct** est actuellement réservé à VoxCPM2.

## Guide japonais indépendant

Choisissez une référence de timbre distincte de l'audio de la réplique actuelle, puis **Guide de jeu de la réplique d'origine** :

- **Consignes acoustiques** : analyse CPU des pauses, variations de hauteur et d'énergie, transformées en consignes pour VoxCPM2. L'audio japonais n'est pas mélangé à la sortie et aucune resynthèse Praat n'est appliquée. Les consignes d'accent et d'humeur restent accessibles.
- **Deux audios · expérimental** : le modèle reçoit la référence de timbre française et la réplique japonaise avec sa transcription originale exacte. Il utilise l'API combinée `reference_wav_path` + `prompt_wav_path` + `prompt_text`. Les consignes séparées d'accent/humeur sont retirées.

![Guide distinct de la voix](screenshots/dual-voice-guide-fr.png)

Le mode à deux audios peut aussi transférer l'accent ou le timbre du guide. Aucun mode ne garantit une séparation parfaite entre identité, accent et jeu, ni une copie exacte de l'émotion ou des syllabes. Il n'y a pas de pourcentage de transfert prétendument mesuré. Comparez de nouveaux essais, et conservez le meilleur. Une référence française jouée reste souvent préférable à un guide japonais lorsqu'il faut stabiliser la prononciation.

Chaque dialogue du lot utilise son propre extrait d'au moins une seconde, 20 secondes au plus, sur la piste choisie. Le mode à deux audios exige aussi le texte source ; les sous-titres doivent correspondre à l'extrait.

## Référence française et accent anglais avec VoxCPM2

Si un fichier de référence parlé uniquement en français donne un accent anglais, choisissez **Privilégier le français de cette référence** et vérifiez sa transcription. Le studio envoie le même audio comme référence de timbre et de continuation, sa transcription exacte et le texte cible sans préfixe anglais. Il retire les commandes séparées d'accent/humeur et le guide distinct. Les options archivées des anciens essais restent lisibles et ne sont pas modifiées.

Une référence de deux secondes et une cible d'un seul mot offrent peu de contexte phonétique. Préférez 5 à 20 secondes de français propre, sans silence excessif. La correction du routage n'est pas un verrou phonétique : des erreurs de diction restent possibles et demandent un nouvel essai ou une autre référence.

## Personnage proposé au moment du doublage

Dans **Doublage**, le studio peut comparer la voix de la réplique aux références **d'origine** des personnages avec CAMPPlus et Silero VAD, sur CPU. Les phrases françaises synthétiques ne servent pas à cette identification. Les extraits originaux assemblés sont admissibles.

Jusqu'à trois propositions sont affichées, avec une similarité qui **n'est pas une probabilité**. Une voix trop courte ou absente demande un choix manuel ; une faible marge entre candidats est signalée. **Accepter** est nécessaire pour assigner un personnage. Le choix manuel reste disponible, et les réglages permettent de désactiver les propositions automatiques ou de changer la piste.

Une proposition est refusée si la réplique, les références, les montages audio ou l'assignation ont changé. Le cache des empreintes dépend du contenu audio et de la version du modèle. Les essais restent conservés lors d'une assignation ou d'une fusion.

## Compatibilité et MCP

La bibliothèque et les guides utilisent le format de projet **21**. Ouvrez une copie avec la v0.30 ou plus récente ; les anciennes versions refusent ce format. Les projets plus anciens restent lisibles.

Sept commandes MCP complètent les outils existants : préparation de source, génération de phrases, validation et lecture de leurs chemins, proposition de personnage, lecture du résultat et acceptation explicite. Les mutations exigent le contexte courant. Voir [MCP](MCP.md).

Sources de l'API : [VoxCPM officiel](https://github.com/OpenBMB/VoxCPM), [guide d'utilisation](https://voxcpm.readthedocs.io/en/latest/usage_guide.html), [exemples de clonage](https://voxcpm.readthedocs.io/en/latest/cookbook.html). L'intégration utilise la version 2.0.3 épinglée et conserve ses licences existantes.
