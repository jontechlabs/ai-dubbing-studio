"""Studio logging shim; no video readers or automatic downloads."""
def zero_rank_log(logger, message):
    logger.info(message)
