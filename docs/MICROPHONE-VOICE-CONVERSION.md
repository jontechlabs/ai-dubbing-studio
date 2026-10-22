# Enregistrement et changement de timbre — v0.23.0

Tout le traitement audio est local. Les modèles et dépendances se téléchargent seulement lors de leur installation. L’enregistrement ne nécessite aucun modèle IA.

## Enregistrer une réplique

1. Sélectionnez une réplique et ouvrez **Doubler / Régénérer**.
2. Déployez **Enregistrer au microphone**, choisissez votre microphone et cliquez sur **Commencer l’enregistrement**. Autorisez le microphone si Windows le demande ; vérifiez aussi Paramètres Windows → Confidentialité et sécurité → Microphone → accès des applications de bureau.
3. Interprétez la réplique. Le niveau, la durée et un indicateur global restent visibles. Le signal ne retourne pas dans les haut-parleurs. L’enregistrement s’arrête automatiquement à 120 secondes. L’arrêt et l’abandon coupent les pistes du microphone.
4. Arrêtez, écoutez la prise, puis cliquez sur **Conserver comme nouvel essai**. **Abandonner la prise** ne crée aucun fichier dans le projet. Une mise à jour ne peut pas fermer le studio tant qu’une prise est en cours ou en attente. Une prise en attente reste accessible via l’indicateur global si vous fermez le panneau. Elle n’est pas sauvegardée avant votre clic et disparaît si vous quittez le studio.

La capture est un WAV PCM 16 bits mono à 24 kHz, sans compression Opus/AAC, sans annulation d’écho, réduction de bruit ou contrôle automatique du gain. Utilisez un casque et réglez le gain matériel : une saturation est signalée. La lecture en cours est mise en pause au début de la prise. Le texte des sous-titres sert d’étiquette ; l’enregistrement reste celui de votre interprétation.

Chaque prise possède son propre fichier. Les prises précédentes sont conservées. L’essai enregistré rejoint les mêmes outils d’écoute, de montage, de volume, de placement sur la timeline et d’export MKV que les essais IA. Une modification de la réplique pendant l’enregistrement empêche une sauvegarde sur un contexte devenu différent.

## Changer le timbre d’un essai

1. Installez **Chatterbox · conversion de timbre** dans **Modèles**. L’espace nécessaire et disponible est vérifié avant de télécharger les dépendances. Les fichiers vont dans le stockage de modèles configuré et suivent ses déplacements.
2. Dans le panneau de doublage, déployez **Changer le timbre de voix** et choisissez l’essai à convertir. Les prises au microphone et les essais de tous les moteurs TTS sont acceptés. Les montages enregistrés de cet essai sont pris en compte.
3. Choisissez une référence du personnage ou un fichier audio déjà importé. Vous pouvez aussi importer un autre fichier, écouter l’extrait et en choisir le début et la fin, avec le même outil que pour les références de doublage.
4. Choisissez la RTX dans le périphérique de conversion et cliquez sur **Créer un essai avec ce timbre**. Le CPU reste disponible explicitement. Une sélection CUDA n’est jamais remplacée silencieusement par le CPU.

Il s’agit d’une conversion **audio vers audio**, avec le moteur officiel [ChatterboxVC](https://github.com/resemble-ai/chatterbox/blob/5de7a54aa4e5e2baadb0182dde554908b48b85c2/src/chatterbox/vc.py) de Resemble AI, sous licence MIT. Ce choix réutilise l’environnement local VoxCPM2/Chatterbox déjà isolé du studio et un modèle d’environ 0,98 Gio ; il ne requiert ni entraînement d’une voix RVC ni transcription. La conversion utilise le son, sans demander à un TTS de relire le texte.

Le contenu, la durée et l’interprétation servent de base à la conversion ; les détails du timbre et de la prosodie ne sont pas garantis identiques à une performance humaine. **Elle ne traduit pas et ne corrige pas automatiquement un accent** : pour un doublage français, choisissez une prise déjà parlée en français et une référence française propre, avec un seul locuteur, peu de bruit et sans musique.

Référence : 1 à 20 secondes sélectionnées ; l’API officielle utilise au plus les 10 premières secondes de cet extrait. Essai : 0,15 à 120 secondes. Le calcul se fait sur des fenêtres de 8 secondes avec contexte et recouvrement, pour borner la mémoire. Les écarts de durée dus à la discrétisation du modèle sont corrigés sans transposition ; un écart incohérent entraîne un échec explicite. La sortie conserve exactement le nombre d’échantillons de l’essai monté. Le filigrane audio Perth prévu par Chatterbox reste appliqué.

L’opération crée un **nouvel essai indépendant** et le sélectionne pour comparaison. Les WAV précédents et la vidéo principale ne sont pas ouverts en écriture. Une annulation, un résultat invalide ou un changement concurrent du projet empêchent le remplacement de la sélection. Le processus du modèle se termine à la fin ou lors d’une annulation, libérant ses allocations GPU.

## Contrôle MCP et format

`studio_microphone` expose `status`, `start`, `stop`, `discard` et `save` dans l’application ouverte, avec indicateur visible et les autorisations du microphone Windows. La configuration de référence de conversion se passe à `studio_convert_voice_timbre` : `generationId`, `referenceId`, `characterId` (ou `null` pour un fichier) et `device`. Les outils existants d’import de référence, d’écoute et de liste des traitements restent utilisables. Ces outils ne transmettent pas l’audio à un service de génération.

Les nouveaux essais portent une provenance `takeOrigin` et passent le projet au **format 17**. Les versions précédentes du studio refusent ce format afin de ne pas perdre ces données. L’historique de projet permet d’annuler la création d’un essai.

## Validation et limites matérielles

La conversion réelle avec les poids officiels a été exécutée localement sur CPU, avec durée exacte et fichiers d’entrée inchangés. Le contrôle continu vérifie aussi un passage entre plusieurs fenêtres et la reconnaissance automatique du français en sortie. La capture Web Audio est testée avec une entrée microphone synthétique du navigateur, puis sauvegarde, rechargement et abandon. Les engagements sur la mémoire viennent du traitement par fenêtres ; la vitesse et la consommation réelles sur RTX 5060 Ti restent à mesurer sur ce GPU.
