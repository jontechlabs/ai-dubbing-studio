# Plusieurs essais pour une réplique

Dans le panneau **Doublage**, régler **Nombre d’essais** sur **1, 2, 3 ou 4**, puis lancer la génération. La valeur par défaut reste 1 et garde le comportement précédent. Cette option concerne la réplique ouverte, y compris un sous-doublage de voix isolée. Les filtres et le doublage par lot de plusieurs répliques restent disponibles séparément.

La même configuration de moteur, référence, accent, humeur, qualité, vitesse et volume est utilisée pour chaque essai. Les graines sont successives à partir de la graine choisie : par exemple 7, 8, 9 et 10. Après 4 294 967 295, la graine revient à 0. Des graines différentes donnent au modèle la possibilité de proposer des variantes ; elles ne garantissent pas des interprétations perceptiblement différentes. Une nouvelle série utilisant la même graine initiale reste reproductible dans les limites du moteur.

La génération s’exécute **une à la fois**, dans une seule tâche annulable. Pour le TTS simple, le modèle reste chargé entre les essais, puis son processus et son contexte GPU sont libérés à la fin, en cas d’annulation ou d’erreur. La progression et le compteur d’essais terminés restent dans le panneau ; le panneau Traitements ne s’ouvre pas automatiquement. À la fin, le dernier essai terminé est sélectionné et accessible pour l’écoute.

Avec **Doublage en 2 étapes**, chaque alternative réalise toute la chaîne : TTS, guide d’intonation éventuel, puis conversion du timbre. Les modèles sont libérés entre les étapes pour éviter leur présence simultanée en VRAM. Les essais intermédiaires et finaux sont conservés. Cette variante recharge les modèles entre les alternatives et peut donc prendre plus de temps.

**Annuler** arrête la série sans supprimer les essais déjà terminés. Une erreur arrête les essais suivants. Le bouton Réessayer reprend les essais restants si le projet est toujours au même état ; il ne régénère pas les essais complets déjà enregistrés. Pour une chaîne interrompue, la reprise utilise le dernier point de contrôle d’étape. Si le texte, le projet ou ses réglages ont changé, une nouvelle série explicite est nécessaire : une reprise périmée est refusée. Les anciens WAV ne sont jamais écrasés.

## MCP

`studio_generate_line` et `studio_generate_dubbing_pipeline` acceptent le paramètre facultatif `count` (entier de 1 à 4 ; défaut 1), à côté de `options` et du contexte courant. Ils renvoient un seul identifiant de tâche. Pour plusieurs essais, la tâche a le type `ttsTrials` et son champ `batch` contient `total`, `completed`, `succeeded` et `currentLineId`. Utiliser `studio_list_jobs` pour suivre la progression et `studio_cancel_job` pour arrêter la série. Les générations conservent chacune leur graine réellement utilisée.

Le format du projet reste 26, les essais existants restent lisibles et le nombre d’outils MCP reste 141. Aucun poids ni moteur d’inférence n’est remplacé par cette fonction.
